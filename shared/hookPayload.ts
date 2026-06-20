/**
 * Pure webhook-payload readers + the canonical glob engine.
 *
 * This is the browser-safe core that both the matcher (`src/hooks/match.ts`)
 * and the essentials layer (`shared/hookEssentials.ts`) build on. Keeping these
 * pure functions here (no node/bun imports) is what lets `shared/` bundle to the
 * browser AND breaks the old `match.ts` ↔ `hookEssentials.ts` import cycle:
 * before, `hookEssentials` reached up into `src/hooks/match` for the readers.
 *
 * Holds:
 *   - `readSentryPayload` / `readDatadogPayload` + their payload types
 *   - `extractHookLabel` (human session label)
 *   - `matchPatternList` + `matchesGlob` — the ONE glob engine. Both the PR/
 *     provider matchers and the prefilter allowlist call these (no duplicates).
 */

/**
 * Walk a nested object by string keys and return the leaf when it's a string,
 * else null. The single shared implementation — `match.ts`, `evaluate.ts`,
 * and `deliveries.ts` all import this instead of redefining it. (The
 * `evaluate.ts` reader additionally stringifies numbers/booleans; it wraps
 * this for its string-only paths and keeps its own widened variant.)
 */
export function readPath(obj: unknown, path: string[]): string | null {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) {
      return null;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" ? cur : null;
}

/** Like `readPath`, but additionally stringifies a numeric/boolean leaf — the
 *  deliveries table + pk derivation read PR numbers, ids, counts, and flags,
 *  not just strings. The single shared widened reader (`evaluate.ts` wraps it
 *  for its field extractors). */
export function readScalarPath(obj: unknown, path: string[]): string | null {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) {
      return null;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur === "string") {
    return cur;
  }
  if (typeof cur === "number" || typeof cur === "boolean") {
    return String(cur);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sentry issue / event identity — the canonical id-path orderings.
// ---------------------------------------------------------------------------

/**
 * Sentry id paths, in priority order. The two orderings genuinely differ, so
 * they're separate arrays here (the single source) and the two extractors below
 * walk them with their respective readers (`sentryIssueId` is string-only and
 * issue-only — the session-coalescing scope; `sentryDeliveryPk` is scalar and
 * tolerates the per-event id fallbacks — the deliveries-table primary key).
 */
const SENTRY_ISSUE_ID_PATHS: string[][] = [
  ["data", "issue", "id"],
  ["data", "event", "issue_id"],
  ["data", "error", "issue_id"],
];
const SENTRY_EVENT_ID_PATHS: string[][] = [
  ["data", "error", "event_id"],
  ["data", "error", "id"],
  ["data", "event", "event_id"],
];

/**
 * The Sentry ISSUE id (the subject threads coalesce on — `sentry-issue-<id>`).
 * String-only, issue-ids only; null when the payload carries none. Used by the
 * GitHub-style scope extractor in `match.ts`.
 */
export function sentryIssueId(payload: unknown): string | null {
  for (const p of SENTRY_ISSUE_ID_PATHS) {
    const v = readPath(payload, p);
    // `?? null` semantics: first NON-null wins (an explicit "" is kept, as the
    // old inline `readStringPath(…) ?? …` chain did — the caller's `id ? …`
    // then treats "" as no-scope).
    if (v !== null) {
      return v;
    }
  }
  return null;
}

/**
 * The Sentry delivery "primary key" shown in the deliveries table. Prefers the
 * issue id (the subject) over per-event ids; tolerates numeric leaves and falls
 * back to the event ids, then "". Used by `extractHookPk` in `evaluate.ts`.
 */
export function sentryDeliveryPk(payload: unknown): string {
  for (const p of [...SENTRY_ISSUE_ID_PATHS, ...SENTRY_EVENT_ID_PATHS]) {
    const v = readScalarPath(payload, p);
    if (v !== null) {
      return v;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Linear identifier — the single regex source of truth.
// ---------------------------------------------------------------------------

/**
 * Linear issue identifiers are `<TEAM>-<n>` (e.g. `ENG-123`). Two shapes are
 * needed and they're genuinely different operations, so each gets a named
 * helper deriving from the same core fragment (`[A-Za-z]…-\d+`):
 *   - `isLinearIdentifier` — anchored exact match for a field already known to
 *     hold an identifier (Linear webhook `data.identifier`). Upper-case only.
 *   - `findLinearId` — loose, case-insensitive search inside free text (branch
 *     names like `adam/eng-123-foo`, PR titles/bodies). Returns the upper-cased
 *     id or null.
 */
const LINEAR_ID_ANCHORED = /^[A-Z][A-Z0-9]*-\d+$/;
const LINEAR_ID_LOOSE = /\b([a-z]{2,}-\d+)\b/i;

/** True when `s` is exactly a Linear identifier (`TEAM-123`). */
export function isLinearIdentifier(s: string | null | undefined): boolean {
  return typeof s === "string" && LINEAR_ID_ANCHORED.test(s);
}

/** First Linear id found in free text, upper-cased, or null. */
export function findLinearId(text: string | null | undefined): string | null {
  const m = typeof text === "string" ? (LINEAR_ID_LOOSE.exec(text)) : null;
  return m ? m[1].toUpperCase() : null;
}

// ---------------------------------------------------------------------------
// Glob engine — the single source of truth.
// ---------------------------------------------------------------------------

/**
 * Tiny glob: `*` (any) and `?` (single). Anchored full-string match.
 *
 * Brackets are LITERAL, not character classes — GitHub bot logins look like
 * `dependabot[bot]` and the spec example `"!*[bot]"` is meaningless if `[bot]`
 * is interpreted as the set {b,o,t}. If someone genuinely needs a character
 * class later, we can add it under a different escape syntax.
 */
export function matchesGlob(pattern: string, value: string): boolean {
  let re = "^";
  for (const c of pattern) {
    if (c === "*") {
      re += ".*";
    } else if (c === "?") {
      re += ".";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  re += "$";
  try {
    return new RegExp(re).test(value);
  } catch {
    return false;
  }
}

/**
 * Evaluate an ordered list of include/exclude globs against a SINGLE value.
 *
 *   ["*", "!*[bot]", "!northisup"]  → include all, then peel off bots, then northisup
 *
 * Documented include/exclude semantics (the ONE place this is decided — P0-8):
 *   - An EMPTY list matches nothing (`false`). Callers that want "any value"
 *     for an optional filter therefore guard with `list.length > 0 && …` so an
 *     empty/unset filter is treated as "no filter" rather than "deny-all".
 *   - An ALL-EXCLUSION list ("everything EXCEPT these") starts INCLUDED, so
 *     deleting the last positive pattern flips a deny-filter to allow-all-but-x
 *     instead of silently matching nothing (e.g. `branch: ["!main"]` must fire
 *     on every non-main branch).
 *   - A list with ANY positive pattern is default-deny until a positive matches.
 */
export function matchPatternList(patterns: string[], value: string): boolean {
  if (patterns.length === 0) {
    return false;
  }
  const lower = value.toLowerCase();
  let included = patterns.every((p) => p.startsWith("!"));
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const pat = (negated ? raw.slice(1) : raw).toLowerCase();
    if (matchesGlob(pat, lower)) {
      included = !negated;
    }
  }
  return included;
}

/**
 * Evaluate an include/exclude glob list against a SET of values (e.g. a
 * delivery's tags). This is set-membership, NOT single-string matching:
 *   - A positive pattern (`service:api`) requires at least one tag to match.
 *   - A negated pattern (`!env:prod`) excludes if any tag matches it.
 *   - An EMPTY rule list means "no tag filter" → matches (`true`); callers no
 *     longer special-case it. (Contrast `matchPatternList`, where empty = deny;
 *     a tag rule is an additive constraint, so "no constraint" passes.)
 *
 * The single documented tag matcher — the Datadog match + skip-reason loops
 * both route through it (P0-8) so they can never drift.
 */
export function matchTagList(patterns: string[], tags: string[]): boolean {
  const lowerTags = tags.map((t) => t.toLowerCase());
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const pat = (negated ? raw.slice(1) : raw).toLowerCase();
    const present = lowerTags.some((t) => matchesGlob(pat, t));
    if (negated ? present : !present) {
      return false;
    }
  }
  return true;
}

/** Per-tag reason a tag list rejected a tag set, or null when it matched.
 *  Shares the exact predicate of `matchTagList` so the skip reason can't
 *  disagree with the match decision. */
export function tagListSkipReason(patterns: string[], tags: string[]): string | null {
  const lowerTags = tags.map((t) => t.toLowerCase());
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const pat = (negated ? raw.slice(1) : raw).toLowerCase();
    const present = lowerTags.some((t) => matchesGlob(pat, t));
    if (negated && present) {
      return `tag \`${pat}\` is excluded`;
    }
    if (!(negated || present)) {
      return `required tag \`${pat}\` not present`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sentry
// ---------------------------------------------------------------------------

export interface SentryPayload {
  /** Webhook resource type (`issue`, `error`, `comment`, `seer`, …). Authoritative
   *  source is the `sentry-hook-resource` header (set by the receiver); inferred
   *  from the body shape here as a fallback. */
  resource: string;
  /** Project slug (`data.issue.project.slug` / `data.event.project`). */
  project: string;
  /** Deploy environment (`production`, `staging`, …) when present. */
  environment: string;
  /** Issue level (`error`, `warning`, `fatal`, …) when present. */
  level: string;
  /** Top-level `action` (`created`, `resolved`, `ignored`, …). */
  action: string;
  /** Host the event came from — `server_name` (top-level or the `server_name`
   *  tag). ERROR events carry it; ISSUE webhooks don't (empty then). */
  serverName: string;
  /** Human ticket id (`CLARA-BACKEND-T1`) from `data.issue.shortId`. ISSUE
   *  webhooks carry it; ERROR events don't (empty then). */
  shortId: string;
}

/** Read a value by key out of Sentry's `[key, value][]` tag array
 *  (`data.error.tags` / `data.event.tags`). Returns the first match's value, or
 *  null. Sentry encodes tags as positional pairs, not an object — e.g.
 *  `["server_name", "d8d9e3ec602738"]`. */
function readTagValue(tags: unknown, key: string): string | null {
  if (!Array.isArray(tags)) {
    return null;
  }
  for (const pair of tags) {
    if (Array.isArray(pair) && pair[0] === key && typeof pair[1] === "string") {
      return pair[1];
    }
  }
  return null;
}

/** Pull the match-relevant fields out of a Sentry integration-platform
 *  webhook body. Resource shapes differ (issue vs error vs alert), so we
 *  probe a few paths and tolerate missing fields. */
export function readSentryPayload(raw: unknown): SentryPayload | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const root = raw as Record<string, unknown>;
  const action = typeof root.action === "string" ? root.action : "";
  const project =
    readPath(root, ["data", "issue", "project", "slug"]) ??
    readPath(root, ["data", "issue", "project", "name"]) ??
    readPath(root, ["data", "event", "project"]) ??
    readPath(root, ["data", "event", "project_slug"]) ??
    readPath(root, ["data", "error", "project"]) ??
    "";
  const level =
    readPath(root, ["data", "issue", "level"]) ??
    readPath(root, ["data", "event", "level"]) ??
    readPath(root, ["data", "error", "level"]) ??
    "";
  const environment =
    readPath(root, ["data", "event", "environment"]) ??
    readPath(root, ["data", "error", "environment"]) ??
    readPath(root, ["data", "issue", "metadata", "environment"]) ??
    readPath(root, ["data", "environment"]) ??
    "";
  // Fallback resource inference from the body shape (the receiver overrides this
  // with the authoritative `sentry-hook-resource` header).
  const data = (root.data ?? {}) as Record<string, unknown>;
  const resource =
    "comment" in data
      ? "comment"
      : "error" in data
        ? "error"
        : "issue" in data
          ? "issue"
          : "";
  // Host: prefer the top-level server_name, else the `server_name` tag value
  // from the `[key,value][]` tags array. Only ERROR/event payloads carry it.
  const serverName =
    readPath(root, ["data", "error", "server_name"]) ??
    readPath(root, ["data", "event", "server_name"]) ??
    readTagValue((data.error as Record<string, unknown> | undefined)?.tags, "server_name") ??
    readTagValue((data.event as Record<string, unknown> | undefined)?.tags, "server_name") ??
    "";
  // shortId is the human ticket id (`CLARA-BACKEND-T1`) — ISSUE webhooks only.
  const shortId =
    readPath(root, ["data", "issue", "shortId"]) ??
    readPath(root, ["data", "issue", "short_id"]) ??
    "";
  return { resource, project, environment, level, action, serverName, shortId };
}

/**
 * Python logging events arrive with Sentry's own `title` set to the raw dict
 * repr of the log record (`{'event': 'checkout failed…', 'dd.trace_id': …}`),
 * which reads as noise in a sidebar row. When the title is such a dict and
 * carries an `event` key, surface that value instead. Anything else passes
 * through untouched — this is display cleanup, not parsing.
 */
export function cleanSentryTitle(title: string): string {
  if (!title.startsWith("{'") && !title.startsWith('{"')) {
    return title;
  }
  const m = /^\{['"]event['"]:\s*(['"])(.*?)\1[,}]/.exec(title);
  return m?.[2] ? m[2] : title;
}

/**
 * Human title for a Sentry webhook, across resource shapes: issue webhooks
 * carry `data.issue.title`, event alerts `data.event.title`, error events
 * `data.error.title`. Falls back to the culprit (the offending code path) when
 * no title exists, then null. The ONE title chain — `extractHookLabel` and the
 * delivery field extractor both use this so sidebar rows and delivery tables
 * can't disagree.
 */
export function extractSentryTitle(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const root = raw as Record<string, unknown>;
  const title =
    readPath(root, ["data", "issue", "title"]) ??
    readPath(root, ["data", "event", "title"]) ??
    readPath(root, ["data", "error", "title"]) ??
    readPath(root, ["data", "issue", "culprit"]) ??
    readPath(root, ["data", "event", "culprit"]) ??
    readPath(root, ["data", "error", "culprit"]) ??
    null;
  return title ? cleanSentryTitle(title) : null;
}

// ---------------------------------------------------------------------------
// Datadog
// ---------------------------------------------------------------------------

export interface DatadogPayload {
  /** Monitor / alert id (`monitor_id` or `id` in the recommended template). */
  monitor: string;
  /** Alert priority (`P1`…`P5`). */
  priority: string;
  /** Alert type / transition (`error`, `warning`, `recovery`, …). */
  type: string;
  /** Tags, normalized to a list (the `$TAGS` template renders a
   *  comma-separated string). */
  tags: string[];
}

/** Read the match-relevant fields from a Datadog webhook body. Datadog
 *  payloads are user-defined; this reads the canonical field names from
 *  the template clawdcode recommends (see datadog.ts). */
export function readDatadogPayload(raw: unknown): DatadogPayload | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const root = raw as Record<string, unknown>;
  const monitor =
    readPath(root, ["monitor_id"]) ?? readPath(root, ["alert_id"]) ?? readPath(root, ["id"]) ?? "";
  const priority = readPath(root, ["priority"]) ?? "";
  const type =
    readPath(root, ["type"]) ??
    readPath(root, ["alert_type"]) ??
    readPath(root, ["transition"]) ??
    "";
  // `$TAGS` renders as "a:b,c:d" (comma) — accept comma OR whitespace.
  const tagsRaw = root.tags;
  let tags: string[] = [];
  if (typeof tagsRaw === "string") {
    tags = tagsRaw
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
  } else if (Array.isArray(tagsRaw)) {
    tags = tagsRaw.filter((t): t is string => typeof t === "string");
  }
  return { monitor, priority, type, tags };
}

// ---------------------------------------------------------------------------
// Linear
// ---------------------------------------------------------------------------

export interface LinearPayload {
  /** Entity type (`Issue`, `Comment`, `Project`, …). */
  type: string;
  /** Action (`create`, `update`, `remove`). */
  action: string;
  /** Issue identifier (`ENG-123`) when present. */
  identifier: string;
  /** Team key (`ENG`) when present. */
  team: string;
  /** Title (issue title, or the parent issue's title for a comment). */
  title: string;
  /** Workflow state name (`Todo`, `In Progress`, `Done`, …) when present. */
  state: string;
  /** Numeric priority (0 None, 1 Urgent, 2 High, 3 Normal, 4 Low). -1 when the
   *  payload doesn't report one (lets the matcher stay lenient on absence). */
  priority: number;
  /** Human label for {@link priority} (`Urgent`/`High`/…). Empty when absent. */
  priorityLabel: string;
  /** Assignee display name when present. */
  assignee: string;
  /** Creator display name when present. */
  creator: string;
  /** Issue label names (`bug`, `p0`, …). */
  labels: string[];
  /** Canonical linear.app issue URL the webhook carries (`data.url`). Empty when
   *  absent — surfaced as the clickable headline link in deliveries / chat. */
  url: string;
  /** Free text worth scanning for the bot @mention (description / comment body). */
  text: string;
  /** Whether the text @mentions the bot. Set by the receiver (env-dependent);
   *  the pure reader leaves it false. */
  mentioned: boolean;
}

/** Linear priority is a 0–4 integer; map it to the label Linear shows in its
 *  UI. The single source of truth so the reader, matcher, and UI agree. */
export const LINEAR_PRIORITY_LABELS = ["None", "Urgent", "High", "Normal", "Low"] as const;

/** Label for a numeric Linear priority (0–4), or "" when out of range / absent. */
export function linearPriorityLabel(priority: number): string {
  return LINEAR_PRIORITY_LABELS[priority] ?? "";
}

/** Read the match-relevant fields from a Linear webhook body. Issue and Comment
 *  payloads nest differently, so we probe both shapes. */
export function readLinearPayload(raw: unknown): LinearPayload {
  const p = (raw ?? {}) as Record<string, unknown>;
  const data = (p.data ?? {}) as Record<string, unknown>;
  const issue = (data.issue ?? {}) as Record<string, unknown>;
  const type = readPath(p, ["type"]) ?? "Issue";
  const action = readPath(p, ["action"]) ?? "";
  const identifier = readPath(data, ["identifier"]) ?? readPath(issue, ["identifier"]) ?? "";
  const team =
    readPath(data, ["team", "key"]) ??
    readPath(issue, ["team", "key"]) ??
    readPath(data, ["teamKey"]) ??
    "";
  const title = readPath(data, ["title"]) ?? readPath(issue, ["title"]) ?? "";
  const state = readPath(data, ["state", "name"]) ?? readPath(issue, ["state", "name"]) ?? "";
  // Priority is a number 0–4. Read it from the issue (or the comment's parent
  // issue); -1 means "absent" so the matcher can stay lenient on missing data.
  const priorityRaw = readNumberPath(data, ["priority"]) ?? readNumberPath(issue, ["priority"]);
  const priority = priorityRaw ?? -1;
  const priorityLabel = linearPriorityLabel(priority);
  const assignee =
    readPath(data, ["assignee", "name"]) ?? readPath(issue, ["assignee", "name"]) ?? "";
  const creator = readPath(data, ["creator", "name"]) ?? readPath(issue, ["creator", "name"]) ?? "";
  const labels = readNameList(data.labels) ?? readNameList(issue.labels) ?? [];
  const url = readPath(data, ["url"]) ?? readPath(issue, ["url"]) ?? readPath(p, ["url"]) ?? "";
  const text = [
    readPath(data, ["description"]),
    readPath(data, ["body"]),
    readPath(issue, ["description"]),
    url || null,
  ]
    .filter((v): v is string => typeof v === "string")
    .join("\n");
  return {
    type,
    action,
    identifier,
    team,
    title,
    state,
    priority,
    priorityLabel,
    assignee,
    creator,
    labels,
    url,
    text,
    mentioned: false,
  };
}

/** Walk a nested object and return the leaf when it's a number, else null. The
 *  numeric sibling of {@link readPath} (Linear's `priority` is an int). */
function readNumberPath(obj: unknown, path: string[]): number | null {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) {
      return null;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "number" ? cur : null;
}

/** Pull `.name` out of an array of `{ name }` objects (Linear's `labels` /
 *  `{ nodes }` shape), dropping non-strings. Returns null for a non-array so the
 *  caller can fall back to another path. */
function readNameList(raw: unknown): string[] | null {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { nodes?: unknown })?.nodes)
      ? (raw as { nodes: unknown[] }).nodes
      : null;
  if (!arr) {
    return null;
  }
  const names: string[] = [];
  for (const item of arr) {
    const name =
      typeof item === "object" && item !== null ? (item as Record<string, unknown>).name : null;
    if (typeof name === "string") {
      names.push(name);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Human session label
// ---------------------------------------------------------------------------

/**
 * Human-readable label for a hook-fired session, surfaced as the session
 * title in the chat browser. Returns:
 *   - `org/repo#N` for GitHub PR-related events (pull_request, reviews,
 *     review comments, issue_comments on PRs).
 *   - `TEAM-1234` for Linear webhooks (placeholder — Linear receiver
 *     isn't wired yet but the shape is documented here so the chat list
 *     groups consistently once it lands).
 *   - null when nothing useful can be extracted.
 */
export function extractHookLabel(event: string, payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const root = payload as Record<string, unknown>;

  if (event.startsWith("sentry:")) {
    const sp = readSentryPayload(root);
    // ISSUE webhooks carry a human ticket id (`CLARA-BACKEND-T1`) — far cleaner
    // for a sidebar row than the long/noisy error title. Prefer it when present.
    if (sp?.shortId) {
      return sp.shortId;
    }
    const title = extractSentryTitle(root);
    const project = sp?.project;
    if (title) {
      return project ? `${project}: ${title}` : title;
    }
    return project ? `Sentry: ${project}` : "Sentry event";
  }
  if (event.startsWith("datadog:")) {
    const title = readPath(root, ["title"]) ?? readPath(root, ["event_title"]) ?? null;
    if (title) {
      return title;
    }
    const monitor = readDatadogPayload(root)?.monitor;
    return monitor ? `Datadog monitor ${monitor}` : "Datadog alert";
  }

  // GitHub PR-class events carry repository.full_name and a number.
  const pr = pickPullRequest(event, root);
  if (pr) {
    const number = typeof pr.number === "number" ? pr.number : null;
    const repo =
      readPath(root, ["repository", "full_name"]) ??
      readPath(root, ["pull_request", "base", "repo", "full_name"]);
    if (number !== null && repo) {
      return `${repo}#${number}`;
    }
  }

  // Linear webhook shape: { type: "Issue" | "Comment" | …, data: { identifier: "LIN-1234", … } }
  const linearIdentifier =
    readPath(root, ["data", "identifier"]) ?? readPath(root, ["data", "issue", "identifier"]);
  if (isLinearIdentifier(linearIdentifier)) {
    return linearIdentifier;
  }

  return null;
}

/**
 * Resolve the `pull_request` node for PR-class events. `issue_comment`
 * deliveries on a PR-issue carry the PR marker on `issue.pull_request`; we
 * synthesize a minimal `{ number }` so the caller's number lookup works.
 *
 * The single shared implementation — `match.ts` imports this instead of keeping
 * its own copy (P2 dedup).
 */
export function pickPullRequest(
  event: string,
  root: Record<string, unknown>,
): Record<string, unknown> | null {
  if (typeof root.pull_request === "object" && root.pull_request !== null) {
    return root.pull_request as Record<string, unknown>;
  }
  if (event === "issue_comment" && typeof root.issue === "object" && root.issue !== null) {
    const issue = root.issue as Record<string, unknown>;
    if (typeof issue.pull_request === "object" && issue.pull_request !== null) {
      const number = typeof issue.number === "number" ? issue.number : null;
      if (number !== null) {
        return { number };
      }
    }
  }
  return null;
}
