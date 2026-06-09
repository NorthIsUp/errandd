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

function readPath(obj: unknown, path: string[]): string | null {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) {
      return null;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" ? cur : null;
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
 * Evaluate an ordered list of include/exclude globs against a value.
 *
 *   ["*", "!*[bot]", "!northisup"]  → include all, then peel off bots, then northisup
 */
export function matchPatternList(patterns: string[], value: string): boolean {
  if (patterns.length === 0) {
    return false;
  }
  const lower = value.toLowerCase();
  // A list made up entirely of exclusions ("!main", "!*[bot]") reads as
  // "everything EXCEPT these" — so it must start included, otherwise there's
  // no positive pattern to ever flip it true and the rule matches nothing
  // (e.g. `prs: true`'s `branch: ["!main"]` would never fire). A list with
  // any positive pattern is default-deny until a positive matches.
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

// ---------------------------------------------------------------------------
// Sentry
// ---------------------------------------------------------------------------

export interface SentryPayload {
  /** Project slug (`data.issue.project.slug` / `data.event.project`). */
  project: string;
  /** Issue level (`error`, `warning`, `fatal`, …) when present. */
  level: string;
  /** Top-level `action` (`created`, `resolved`, `ignored`, …). */
  action: string;
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
  return { project, level, action };
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
    const title =
      readPath(root, ["data", "issue", "title"]) ??
      readPath(root, ["data", "event", "title"]) ??
      readPath(root, ["data", "error", "title"]) ??
      null;
    const project = readSentryPayload(root)?.project;
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
  // Linear identifiers look like TEAM-N — match against `^[A-Z]+-\d+$`.
  const linearIdentifier =
    readPath(root, ["data", "identifier"]) ?? readPath(root, ["data", "issue", "identifier"]);
  if (linearIdentifier && /^[A-Z][A-Z0-9]*-\d+$/.test(linearIdentifier)) {
    return linearIdentifier;
  }

  return null;
}

/**
 * Resolve the `pull_request` node for PR-class events. `issue_comment`
 * deliveries on a PR-issue carry the PR marker on `issue.pull_request`; we
 * synthesize a minimal `{ number }` so the caller's number lookup works.
 */
function pickPullRequest(
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
