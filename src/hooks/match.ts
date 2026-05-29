/**
 * Match a parsed GitHub webhook payload against a HookConfig.
 *
 * Glob semantics (see PR_HOOKS_SPEC.md):
 *   - Patterns are evaluated in order, case-insensitively.
 *   - A bare pattern includes; a `!`-prefixed pattern excludes.
 *   - State starts at "not included" and flips per match.
 */

import type { DatadogRule, PrRule, SentryRule } from "./schema";

export interface PrPayload {
  action: string;
  user: string;
  repo: string; // "org/repo"
  baseBranch: string;
  labels: string[];
  draft: boolean;
}

/** Extract a normalized PR payload from a `pull_request` webhook body. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: defensive payload extraction — splitting it just spreads branches across helpers.
export function readPrPayload(raw: unknown): PrPayload | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const root = raw as Record<string, unknown>;
  const action = typeof root.action === "string" ? root.action : "";
  const pr = root.pull_request;
  const repoObj = root.repository;
  if (typeof pr !== "object" || pr === null) {
    return null;
  }
  if (typeof repoObj !== "object" || repoObj === null) {
    return null;
  }
  const prObj = pr as Record<string, unknown>;
  const repoR = repoObj as Record<string, unknown>;

  const user = readPath(prObj, ["user", "login"]) ?? "";
  const repo =
    (typeof repoR.full_name === "string" ? repoR.full_name : null) ??
    `${readPath(repoR, ["owner", "login"]) ?? "?"}/${
      typeof repoR.name === "string" ? repoR.name : "?"
    }`;
  const baseBranch = readPath(prObj, ["base", "ref"]) ?? "";
  const draft = prObj.draft === true;
  const labelsRaw = prObj.labels;
  const labels: string[] = [];
  if (Array.isArray(labelsRaw)) {
    for (const l of labelsRaw) {
      if (
        typeof l === "object" &&
        l !== null &&
        typeof (l as Record<string, unknown>).name === "string"
      ) {
        labels.push((l as Record<string, unknown>).name as string);
      }
    }
  }
  return { action, user, repo, baseBranch, labels, draft };
}

function readPath(obj: Record<string, unknown>, path: string[]): string | null {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) {
      return null;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" ? cur : null;
}

/** Returns true if the rule matches the payload. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each `if` guards a distinct rule dimension; flattening into helpers loses readability.
export function matchPrRule(rule: PrRule, p: PrPayload): boolean {
  if (!matchRepo(rule.repo, p.repo)) {
    return false;
  }
  if (!matchPatternList(rule.user, p.user)) {
    return false;
  }
  if (rule.action.length > 0 && !rule.action.some((a) => a === "*" || a === p.action)) {
    return false;
  }
  if (rule.branch.length > 0 && !matchPatternList(rule.branch, p.baseBranch)) {
    return false;
  }
  if (rule.draft !== "any" && rule.draft !== p.draft) {
    return false;
  }
  for (const required of rule.labels) {
    if (required.startsWith("!")) {
      if (
        matchesGlob(
          required.slice(1),
          p.labels.find((l) => matchesGlob(required.slice(1), l)) ?? "",
        )
      ) {
        return false;
      }
    } else if (!p.labels.some((l) => matchesGlob(required, l))) {
      return false;
    }
  }
  return true;
}

function matchRepo(rule: string | string[], repo: string): boolean {
  const list = Array.isArray(rule) ? rule : [rule];
  return list.some((pat) => matchesGlob(pat.toLowerCase(), repo.toLowerCase()));
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
  if (typeof raw !== "object" || raw === null) return null;
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

/** True when a SentryRule matches the payload. Empty `level`/`action`
 *  lists mean "any". `project` defaults to `["*"]` so it always has a
 *  value to evaluate. */
export function matchSentryRule(rule: SentryRule, p: SentryPayload): boolean {
  if (rule.project.length > 0 && !matchPatternList(rule.project, p.project)) {
    return false;
  }
  if (rule.level.length > 0 && !(p.level && matchPatternList(rule.level, p.level))) {
    return false;
  }
  if (rule.action.length > 0 && !(p.action && matchPatternList(rule.action, p.action))) {
    return false;
  }
  return true;
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
  if (typeof raw !== "object" || raw === null) return null;
  const root = raw as Record<string, unknown>;
  const monitor =
    readPath(root, ["monitor_id"]) ??
    readPath(root, ["alert_id"]) ??
    readPath(root, ["id"]) ??
    "";
  const priority = readPath(root, ["priority"]) ?? "";
  const type =
    readPath(root, ["type"]) ?? readPath(root, ["alert_type"]) ?? readPath(root, ["transition"]) ?? "";
  // `$TAGS` renders as "a:b,c:d" (comma) — accept comma OR whitespace.
  const tagsRaw = root.tags;
  let tags: string[] = [];
  if (typeof tagsRaw === "string") {
    tags = tagsRaw.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  } else if (Array.isArray(tagsRaw)) {
    tags = tagsRaw.filter((t): t is string => typeof t === "string");
  }
  return { monitor, priority, type, tags };
}

/** True when a DatadogRule matches the payload. */
export function matchDatadogRule(rule: DatadogRule, p: DatadogPayload): boolean {
  if (rule.monitor.length > 0 && !matchPatternList(rule.monitor, p.monitor)) {
    return false;
  }
  if (rule.priority.length > 0 && !(p.priority && matchPatternList(rule.priority, p.priority))) {
    return false;
  }
  if (rule.type.length > 0 && !(p.type && matchPatternList(rule.type, p.type))) {
    return false;
  }
  // Tag rule: every required (non-`!`) tag must match at least one payload
  // tag; any `!`-tag that matches a payload tag excludes the delivery.
  for (const req of rule.tags) {
    const negated = req.startsWith("!");
    const pat = (negated ? req.slice(1) : req).toLowerCase();
    const present = p.tags.some((t) => matchesGlob(pat, t.toLowerCase()));
    if (negated && present) return false;
    if (!negated && !present) return false;
  }
  return true;
}

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
 * Derive a stable "scope" string from a GitHub webhook delivery so that
 * multiple deliveries belonging to the same logical unit of work (e.g. all
 * comments on PR #42) route to the same job thread / Claude session.
 *
 * Resolution order:
 *   1. PR number from pickPullRequest (top-level pull_request OR
 *      issue_comment on a PR-issue) → `pr-<number>`
 *   2. PR head ref anywhere in the payload → `branch-<slug>`
 *   3. Plain issue number → `issue-<number>`
 *   4. Linear issue identifier → lowercased `lin-<team>-<n>`
 *   5. null when no useful scope can be extracted
 *
 * The scope is intentionally just `pr-<number>` (no branch slug) so a
 * force-push that renames the head doesn't fork the conversation — the
 * PR number alone is the stable identity.
 */
export function extractHookScope(event: string, payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const root = payload as Record<string, unknown>;

  // Non-GitHub providers thread through as `sentry:…` / `datadog:…`
  // events. Each has its own stable identity for session coalescing.
  if (event.startsWith("sentry:")) {
    const issueId =
      readPath(root, ["data", "issue", "id"]) ??
      readPath(root, ["data", "event", "issue_id"]) ??
      readPath(root, ["data", "error", "issue_id"]) ??
      null;
    if (issueId) return `sentry-issue-${issueId}`;
    return null;
  }
  if (event.startsWith("datadog:")) {
    // Aggregation key groups all alerts in one monitor cycle; fall back to
    // monitor id so re-alerts on the same monitor coalesce.
    const aggreg = readPath(root, ["aggreg_key"]) ?? readPath(root, ["alert_cycle_key"]) ?? null;
    if (aggreg) return `dd-${slugifyBranch(aggreg)}`;
    const monitor =
      readPath(root, ["monitor_id"]) ?? readPath(root, ["alert_id"]) ?? readPath(root, ["id"]) ?? null;
    if (monitor) return `dd-monitor-${slugifyBranch(monitor)}`;
    return null;
  }

  // 1. PR number is the cleanest identity — same number across opens,
  // synchronize, reviews, comments, merges.
  const pr = pickPullRequest(event, root);
  if (pr && typeof pr.number === "number") {
    return `pr-${pr.number}`;
  }

  // 2. Some payloads expose a head ref but no PR number (push events,
  // workflow_run, partial PR payloads). Use the branch as the scope so
  // multiple events on the same branch coalesce.
  const headRef =
    readPath(root, ["pull_request", "head", "ref"]) ??
    readPath(root, ["check_run", "check_suite", "head_branch"]) ??
    readPath(root, ["workflow_run", "head_branch"]) ??
    readPath(root, ["ref"])?.replace(/^refs\/heads\//, "") ??
    null;
  if (headRef) {
    const slug = slugifyBranch(headRef);
    if (slug) return `branch-${slug}`;
  }

  // 3. Plain (non-PR) issue. `issue.number` is numeric in GitHub
  // payloads, so we can't use readPath (which only returns strings).
  const issue = root.issue;
  if (typeof issue === "object" && issue !== null) {
    const num = (issue as Record<string, unknown>).number;
    if (typeof num === "number") {
      return `issue-${num}`;
    }
  }

  // 4. Linear webhook shape.
  const linear =
    readPath(root, ["data", "identifier"]) ?? readPath(root, ["data", "issue", "identifier"]);
  if (linear && /^[A-Z][A-Z0-9]*-\d+$/.test(linear)) {
    return `lin-${linear.toLowerCase()}`;
  }

  return null;
}

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
  if (typeof payload !== "object" || payload === null) return null;
  const root = payload as Record<string, unknown>;

  if (event.startsWith("sentry:")) {
    const title =
      readPath(root, ["data", "issue", "title"]) ??
      readPath(root, ["data", "event", "title"]) ??
      readPath(root, ["data", "error", "title"]) ??
      null;
    const project = readSentryPayload(root)?.project;
    if (title) return project ? `${project}: ${title}` : title;
    return project ? `Sentry: ${project}` : "Sentry event";
  }
  if (event.startsWith("datadog:")) {
    const title = readPath(root, ["title"]) ?? readPath(root, ["event_title"]) ?? null;
    if (title) return title;
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
 * Distill a GitHub webhook payload into the small object we hand to a
 * job's prompt. GitHub payloads are huge (repo metadata is repeated 3-4
 * times, every actor inlines a dozen API URLs, the PR body itself can
 * run to hundreds of lines), but a job only needs the identifiers and
 * the human-meaningful state. Anything missing is recoverable via
 * `gh pr view <repo>#<n> --json …` from inside the agent.
 *
 * Currently handles the four PR-class events. Unknown event types fall
 * back to a minimal `{ event, action, sender, repo }` envelope.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one branch per event shape — flattening just hides the structure.
export function summarizeHookPayload(event: string, payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) {
    return { event };
  }
  const root = payload as Record<string, unknown>;

  if (event.startsWith("sentry:")) {
    return summarizeSentryPayload(event, root);
  }
  if (event.startsWith("datadog:")) {
    return summarizeDatadogPayload(event, root);
  }

  const action = typeof root.action === "string" ? root.action : undefined;
  const repo = readPath(root, ["repository", "full_name"]) ?? undefined;
  const sender = readPath(root, ["sender", "login"]) ?? undefined;
  const envelope: Record<string, unknown> = { event, action, repo, sender };

  const pr = pickPullRequest(event, root);
  if (pr && typeof pr.number === "number") {
    // Some shapes synthesized by pickPullRequest only carry `number`;
    // try the real top-level pull_request for fuller data.
    const fullPr =
      typeof root.pull_request === "object" && root.pull_request !== null
        ? (root.pull_request as Record<string, unknown>)
        : pr;
    envelope.pr = {
      number: pr.number,
      title: readPath(fullPr, ["title"]) ?? undefined,
      url: readPath(fullPr, ["html_url"]) ?? undefined,
      state: readPath(fullPr, ["state"]) ?? undefined,
      draft: typeof fullPr.draft === "boolean" ? fullPr.draft : undefined,
      head: readPath(fullPr, ["head", "ref"]) ?? undefined,
      base: readPath(fullPr, ["base", "ref"]) ?? undefined,
      author: readPath(fullPr, ["user", "login"]) ?? undefined,
    };
  }

  if (event === "pull_request_review" && typeof root.review === "object" && root.review !== null) {
    const review = root.review as Record<string, unknown>;
    envelope.review = {
      state: readPath(review, ["state"]) ?? undefined,
      url: readPath(review, ["html_url"]) ?? undefined,
      // Include short review body but cap length — long reviews can be
      // fetched via gh pr view --json reviews.
      body: truncate(readPath(review, ["body"]), 500),
    };
  }

  if (
    (event === "issue_comment" || event === "pull_request_review_comment") &&
    typeof root.comment === "object" &&
    root.comment !== null
  ) {
    const comment = root.comment as Record<string, unknown>;
    envelope.comment = {
      url: readPath(comment, ["html_url"]) ?? undefined,
      author: readPath(comment, ["user", "login"]) ?? undefined,
      // Per-line comments include file + line context.
      path: readPath(comment, ["path"]) ?? undefined,
      line:
        typeof comment.line === "number"
          ? comment.line
          : typeof comment.original_line === "number"
            ? comment.original_line
            : undefined,
      body: truncate(readPath(comment, ["body"]), 2000),
    };
  }

  return prune(envelope);
}

/** Distill a Sentry webhook into the small object handed to the prompt.
 *  Sentry bodies inline the full event (stacktrace, breadcrumbs, etc.) —
 *  the agent fetches detail via the Sentry MCP / web URL, so we keep just
 *  the identity + a short culprit/title. */
function summarizeSentryPayload(event: string, root: Record<string, unknown>): unknown {
  const s = readSentryPayload(root);
  const issue =
    typeof root.data === "object" && root.data !== null
      ? ((root.data as Record<string, unknown>).issue as Record<string, unknown> | undefined)
      : undefined;
  const url =
    readPath(issue ?? {}, ["web_url"]) ??
    readPath(issue ?? {}, ["permalink"]) ??
    readPath(root, ["data", "event", "web_url"]) ??
    undefined;
  return prune({
    event,
    action: s?.action || undefined,
    project: s?.project || undefined,
    level: s?.level || undefined,
    title:
      readPath(issue ?? {}, ["title"]) ??
      readPath(root, ["data", "event", "title"]) ??
      undefined,
    culprit: readPath(issue ?? {}, ["culprit"]) ?? undefined,
    count: issue && typeof issue.count !== "undefined" ? String(issue.count) : undefined,
    url,
  });
}

/** Distill a Datadog webhook. Datadog payloads are user-shaped, so we
 *  surface the canonical template fields plus the message body. */
function summarizeDatadogPayload(event: string, root: Record<string, unknown>): unknown {
  const d = readDatadogPayload(root);
  return prune({
    event,
    monitor: d?.monitor || undefined,
    priority: d?.priority || undefined,
    type: d?.type || undefined,
    status: readPath(root, ["status"]) ?? readPath(root, ["alert_status"]) ?? undefined,
    title: readPath(root, ["title"]) ?? readPath(root, ["event_title"]) ?? undefined,
    message: truncate(readPath(root, ["message"]) ?? readPath(root, ["event_msg"]), 1000),
    tags: d && d.tags.length > 0 ? d.tags : undefined,
    link: readPath(root, ["link"]) ?? undefined,
    hostname: readPath(root, ["hostname"]) ?? undefined,
  });
}

/** Drop undefined/null fields recursively so the rendered JSON is tight. */
function prune(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(prune);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || v === null) continue;
      const pruned = prune(v);
      if (pruned === undefined) continue;
      out[k] = pruned;
    }
    return out;
  }
  return value;
}

function truncate(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max)}… [truncated]` : trimmed;
}

/**
 * Build a structured trigger record from a webhook payload, persisted
 * on the session-meta entry so the Runs view can render
 * "comment on PR #415" instead of "scheduled" for hook-driven sessions.
 */
export function buildHookTrigger(
  event: string,
  payload: unknown,
): {
  event: string;
  action?: string;
  repo?: string;
  pr?: { number: number; url?: string };
  actor?: string;
} {
  if (typeof payload !== "object" || payload === null) {
    return { event };
  }
  const root = payload as Record<string, unknown>;

  // Non-GitHub providers carry their own identity. We reuse the `repo`
  // slot as the human "where" (project / monitor) so the existing Runs
  // view renderer has something to show without a schema change.
  if (event.startsWith("sentry:")) {
    const s = readSentryPayload(root);
    return {
      event,
      ...(s?.action ? { action: s.action } : {}),
      ...(s?.project ? { repo: s.project } : {}),
    };
  }
  if (event.startsWith("datadog:")) {
    const d = readDatadogPayload(root);
    return {
      event,
      ...(d?.type ? { action: d.type } : {}),
      ...(d?.monitor ? { repo: `monitor ${d.monitor}` } : {}),
    };
  }

  const action = typeof root.action === "string" ? root.action : undefined;
  const repo = readPath(root, ["repository", "full_name"]) ?? undefined;
  const pr = pickPullRequest(event, root);
  const fullPr =
    typeof root.pull_request === "object" && root.pull_request !== null
      ? (root.pull_request as Record<string, unknown>)
      : pr;
  const actor =
    readPath(root, ["comment", "user", "login"]) ??
    readPath(root, ["review", "user", "login"]) ??
    readPath(root, ["sender", "login"]) ??
    undefined;
  const prUrl = fullPr ? readPath(fullPr, ["html_url"]) : null;
  return {
    event,
    ...(action ? { action } : {}),
    ...(repo ? { repo } : {}),
    ...(pr && typeof pr.number === "number"
      ? { pr: { number: pr.number, ...(prUrl ? { url: prUrl } : {}) } }
      : {}),
    ...(actor ? { actor } : {}),
  };
}

/**
 * Render the summary as a markdown bullet list — the format we hand to
 * the agent in the prompt. Markdown beats JSON/YAML here because:
 *   - URLs become tokenized as single linkified units
 *   - the agent reads bullet lists more naturally than structured data
 *     when the goal is comprehension, not parsing
 *   - ~25% fewer tokens than the equivalent JSON
 * If the agent needs structured access, it can `gh pr view <repo>#<n>`.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: linear "build a bullet list per event shape"; helpers would shred the flow.
export function renderHookSummaryMarkdown(event: string, payload: unknown): string {
  const s = summarizeHookPayload(event, payload) as Record<string, unknown>;
  const lines: string[] = [];
  const ev = s.event ?? event;
  const action = s.action ? ` (${s.action})` : "";
  lines.push(`- **event**: ${ev}${action}`);

  // Sentry / Datadog summaries have their own field set — render and
  // return early.
  if (typeof ev === "string" && ev.startsWith("sentry:")) {
    if (s.project) lines.push(`- **project**: ${s.project}`);
    if (s.level) lines.push(`- **level**: ${s.level}`);
    if (s.title) {
      lines.push(s.url ? `- **issue**: [${s.title}](${s.url})` : `- **issue**: ${s.title}`);
    }
    if (s.culprit) lines.push(`  - culprit: \`${s.culprit}\``);
    if (s.count) lines.push(`  - count: ${s.count}`);
    return lines.join("\n");
  }
  if (typeof ev === "string" && ev.startsWith("datadog:")) {
    if (s.monitor) lines.push(`- **monitor**: ${s.monitor}`);
    if (s.priority) lines.push(`- **priority**: ${s.priority}`);
    if (s.status) lines.push(`- **status**: ${s.status}`);
    if (s.title) {
      lines.push(s.link ? `- **alert**: [${s.title}](${s.link})` : `- **alert**: ${s.title}`);
    }
    if (Array.isArray(s.tags) && s.tags.length > 0) {
      lines.push(`  - tags: ${(s.tags as string[]).join(", ")}`);
    }
    if (s.hostname) lines.push(`  - host: ${s.hostname}`);
    if (typeof s.message === "string") lines.push(`  - ${oneLine(s.message)}`);
    return lines.join("\n");
  }

  if (s.repo) lines.push(`- **repo**: ${s.repo}`);
  if (s.sender) lines.push(`- **sender**: ${s.sender}`);

  const pr = s.pr as Record<string, unknown> | undefined;
  if (pr && typeof pr.number === "number") {
    const titlePart = pr.title ? ` — ${pr.title}` : "";
    const linkText = `#${pr.number}${titlePart}`;
    const prLine = pr.url
      ? `- **PR**: [${linkText}](${pr.url})`
      : `- **PR**: ${linkText}`;
    lines.push(prLine);
    const subs: string[] = [];
    if (pr.state || typeof pr.draft === "boolean") {
      const draftBit = typeof pr.draft === "boolean" ? ` · draft: ${pr.draft}` : "";
      subs.push(`state: ${pr.state ?? "?"}${draftBit}`);
    }
    if (pr.head || pr.base) {
      subs.push(`head: \`${pr.head ?? "?"}\` → base: \`${pr.base ?? "?"}\``);
    }
    if (pr.author) subs.push(`author: ${pr.author}`);
    for (const sub of subs) lines.push(`  - ${sub}`);
  }

  const review = s.review as Record<string, unknown> | undefined;
  if (review) {
    const rState = review.state ?? "?";
    const reviewLine = review.url
      ? `- **Review**: ${rState} — [link](${review.url})`
      : `- **Review**: ${rState}`;
    lines.push(reviewLine);
    if (typeof review.body === "string") {
      lines.push(`  - body: ${oneLine(review.body)}`);
    }
  }

  const comment = s.comment as Record<string, unknown> | undefined;
  if (comment) {
    const author = comment.author ?? "?";
    const location =
      comment.path && typeof comment.line === "number"
        ? ` at \`${comment.path}:${comment.line}\``
        : comment.path
          ? ` at \`${comment.path}\``
          : "";
    const cLine = comment.url
      ? `- **Comment** by ${author}${location} — [link](${comment.url})`
      : `- **Comment** by ${author}${location}`;
    lines.push(cLine);
    if (typeof comment.body === "string") {
      lines.push(`  - body: ${oneLine(comment.body)}`);
    }
  }

  return lines.join("\n");
}

/** Collapse a multi-line string to one line for inline-bullet rendering. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function pickPullRequest(
  event: string,
  root: Record<string, unknown>,
): Record<string, unknown> | null {
  // pull_request, pull_request_review, pull_request_review_comment all
  // include a top-level "pull_request" object.
  if (typeof root.pull_request === "object" && root.pull_request !== null) {
    return root.pull_request as Record<string, unknown>;
  }
  // issue_comment: the issue may or may not be a PR. PRs carry the
  // pull_request sub-object on the issue itself, plus head/base info isn't
  // present — for those we fall back to the issue number alone (no slug).
  if (event === "issue_comment" && typeof root.issue === "object" && root.issue !== null) {
    const issue = root.issue as Record<string, unknown>;
    if (typeof issue.pull_request === "object" && issue.pull_request !== null) {
      // Synthesize a minimal shape so the caller's number lookup works.
      const number = typeof issue.number === "number" ? issue.number : null;
      if (number !== null) return { number };
    }
  }
  return null;
}

/** GitHub branch refs can contain slashes and other characters that make them
 *  awkward to embed in a thread ID. Map to a conservative slug. */
function slugifyBranch(ref: string): string {
  return ref
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
