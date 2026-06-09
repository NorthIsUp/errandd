/**
 * Match a parsed GitHub webhook payload against a HookConfig.
 *
 * Glob semantics (see PR_HOOKS_SPEC.md):
 *   - Patterns are evaluated in order, case-insensitively.
 *   - A bare pattern includes; a `!`-prefixed pattern excludes.
 *   - State starts at "not included" and flips per match.
 */

import {
  buildHookEssentials,
  renderHookEssentialsMarkdown,
} from "../../shared/hookEssentials";
import {
  type DatadogPayload,
  type SentryPayload,
  extractHookLabel,
  isLinearIdentifier,
  matchPatternList,
  matchTagList,
  matchesGlob,
  pickPullRequest,
  readDatadogPayload,
  readPath as readStringPath,
  readSentryPayload,
  tagListSkipReason,
} from "../../shared/hookPayload";
import type { DatadogRule, PrRule, SentryRule } from "./schema";

// Back-compat re-exports: these pure payload readers + the glob engine moved to
// shared/hookPayload.ts (so shared/ no longer reaches up into src/ and the
// match.ts ↔ hookEssentials.ts cycle is broken). Existing importers still pull
// them from "./match".
export {
  type DatadogPayload,
  type SentryPayload,
  extractHookLabel,
  matchPatternList,
  matchesGlob,
  readDatadogPayload,
  readSentryPayload,
};

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

  const user = readStringPath(prObj, ["user", "login"]) ?? "";
  const repo =
    (typeof repoR.full_name === "string" ? repoR.full_name : null) ??
    `${readStringPath(repoR, ["owner", "login"]) ?? "?"}/${
      typeof repoR.name === "string" ? repoR.name : "?"
    }`;
  const baseBranch = readStringPath(prObj, ["base", "ref"]) ?? "";
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

/**
 * Single source of truth for PR-rule matching: evaluate every dimension in
 * order and return whether it matched plus, when it didn't, the human reason.
 * `matchPrRule` and `prRuleSkipReason` both derive from this so the skip
 * message can never disagree with the match decision (previously the reason
 * builder omitted the label dimension and could report "no PR rule matched"
 * for a label-rejected PR).
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each block guards a distinct rule dimension in priority order; splitting loses the readable flow.
export function evalPrRule(rule: PrRule, p: PrPayload): { ok: boolean; reason?: string } {
  if (!matchRepo(rule.repo, p.repo)) {
    return { ok: false, reason: `repo \`${p.repo}\` not in the repo filter` };
  }
  if (!matchPatternList(rule.user, p.user)) {
    return { ok: false, reason: `author \`${p.user}\` excluded by the user filter` };
  }
  if (rule.action.length > 0 && !rule.action.some((a) => a === "*" || a === p.action)) {
    return { ok: false, reason: `action \`${p.action}\` not in the action filter` };
  }
  if (rule.branch.length > 0 && !matchPatternList(rule.branch, p.baseBranch)) {
    return { ok: false, reason: `base branch \`${p.baseBranch}\` excluded by the branch filter` };
  }
  if (rule.draft !== "any" && rule.draft !== p.draft) {
    return { ok: false, reason: p.draft ? "PR is a draft" : "PR is not a draft" };
  }
  for (const required of rule.labels) {
    if (required.startsWith("!")) {
      const pat = required.slice(1);
      if (p.labels.some((l) => matchesGlob(pat, l))) {
        return { ok: false, reason: `excluded label \`${pat}\` present` };
      }
    } else if (!p.labels.some((l) => matchesGlob(required, l))) {
      return { ok: false, reason: `required label \`${required}\` not present` };
    }
  }
  return { ok: true };
}

/** Returns true if the rule matches the payload. */
export function matchPrRule(rule: PrRule, p: PrPayload): boolean {
  return evalPrRule(rule, p).ok;
}

/**
 * Human-readable reason a PR payload matched NO rule — used to surface
 * config-driven skips in the Runs view. Explains the first rule's first
 * failing dimension (the common case is a single `prs: true` rule whose
 * `branch: ["!main"]` rejects a main-targeting PR).
 */
export function prRuleSkipReason(rules: PrRule[], p: PrPayload): string {
  const r = rules[0];
  if (!r) {
    return "no PR trigger configured";
  }
  return evalPrRule(r, p).reason ?? "no PR rule matched";
}

function matchRepo(rule: string | string[], repo: string): boolean {
  const list = Array.isArray(rule) ? rule : [rule];
  return list.some((pat) => matchesGlob(pat.toLowerCase(), repo.toLowerCase()));
}

/** A PR-level "don't touch this" label: when a PR carries `claw:ignore`, every
 *  hook (PR events + comments on it) is skipped, independent of routine config.
 *  A human flips this to make the bot leave a specific PR alone. */
export const CLAW_IGNORE_LABEL = "claw:ignore";

/** Skip reason emitted when a PR is ignored — shared so the skip session can be
 *  marked `[skip:ignore]` distinctly from other skips. */
export const CLAW_IGNORE_SKIP_REASON = "ignore — PR has the `claw:ignore` label";

/** True when the delivery's PR carries the `claw:ignore` label. Reads from
 *  `pull_request.labels` (PR + review events) or `issue.labels` (issue_comment
 *  on a PR), case-insensitively. */
export function hasClawIgnoreLabel(event: string, payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const root = payload as Record<string, unknown>;
  const node = event === "issue_comment" ? root.issue : root.pull_request;
  if (typeof node !== "object" || node === null) {
    return false;
  }
  const labels = (node as Record<string, unknown>).labels;
  if (!Array.isArray(labels)) {
    return false;
  }
  return labels.some((l) => {
    const name = typeof l === "object" && l !== null ? (l as Record<string, unknown>).name : null;
    return typeof name === "string" && name.toLowerCase() === CLAW_IGNORE_LABEL;
  });
}

// ---------------------------------------------------------------------------
// Sentry
// ---------------------------------------------------------------------------

/**
 * Single source of truth for Sentry-rule matching — same `{ok, reason?}`
 * pattern as `evalPrRule`, so `matchSentryRule` and `sentryRuleSkipReason`
 * derive from it and the skip message can never disagree with the match.
 * Empty `level`/`action` lists mean "any"; `project` defaults to `["*"]`.
 */
export function evalSentryRule(rule: SentryRule, p: SentryPayload): { ok: boolean; reason?: string } {
  if (rule.project.length > 0 && !matchPatternList(rule.project, p.project)) {
    return { ok: false, reason: `project \`${p.project || "?"}\` not in the project filter` };
  }
  if (rule.level.length > 0 && !(p.level && matchPatternList(rule.level, p.level))) {
    return { ok: false, reason: `level \`${p.level || "?"}\` not in the level filter` };
  }
  if (rule.action.length > 0 && !(p.action && matchPatternList(rule.action, p.action))) {
    return { ok: false, reason: `action \`${p.action || "?"}\` not in the action filter` };
  }
  return { ok: true };
}

/** True when a SentryRule matches the payload. */
export function matchSentryRule(rule: SentryRule, p: SentryPayload): boolean {
  return evalSentryRule(rule, p).ok;
}

/** Human-readable reason a Sentry payload matched NO rule. Surfaces filtered
 *  deliveries in the deliveries table. */
export function sentryRuleSkipReason(rule: SentryRule, p: SentryPayload): string {
  return evalSentryRule(rule, p).reason ?? "no Sentry rule matched";
}

// ---------------------------------------------------------------------------
// Datadog
// ---------------------------------------------------------------------------

/**
 * Single source of truth for Datadog-rule matching — `{ok, reason?}` like
 * `evalPrRule`/`evalSentryRule`. The tag dimension is set-membership (a rule
 * tag must match at least one payload tag; a `!`-tag excludes if present), so
 * it routes through the shared `matchTagList`/`tagListSkipReason` (P0-8) rather
 * than a hand-rolled loop that could drift from the match decision.
 */
export function evalDatadogRule(
  rule: DatadogRule,
  p: DatadogPayload,
): { ok: boolean; reason?: string } {
  if (rule.monitor.length > 0 && !matchPatternList(rule.monitor, p.monitor)) {
    return { ok: false, reason: `monitor \`${p.monitor || "?"}\` not in the monitor filter` };
  }
  if (rule.priority.length > 0 && !(p.priority && matchPatternList(rule.priority, p.priority))) {
    return { ok: false, reason: `priority \`${p.priority || "?"}\` not in the priority filter` };
  }
  if (rule.type.length > 0 && !(p.type && matchPatternList(rule.type, p.type))) {
    return { ok: false, reason: `type \`${p.type || "?"}\` not in the type filter` };
  }
  const tagReason = tagListSkipReason(rule.tags, p.tags);
  if (tagReason) {
    return { ok: false, reason: tagReason };
  }
  return { ok: true };
}

/** True when a DatadogRule matches the payload. */
export function matchDatadogRule(rule: DatadogRule, p: DatadogPayload): boolean {
  // monitor/priority/type are single-value globs; tags are set-membership.
  if (rule.monitor.length > 0 && !matchPatternList(rule.monitor, p.monitor)) {
    return false;
  }
  if (rule.priority.length > 0 && !(p.priority && matchPatternList(rule.priority, p.priority))) {
    return false;
  }
  if (rule.type.length > 0 && !(p.type && matchPatternList(rule.type, p.type))) {
    return false;
  }
  return matchTagList(rule.tags, p.tags);
}

/** Human-readable reason a Datadog payload matched NO rule. */
export function datadogRuleSkipReason(rule: DatadogRule, p: DatadogPayload): string {
  return evalDatadogRule(rule, p).reason ?? "no Datadog rule matched";
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
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const root = payload as Record<string, unknown>;

  // Non-GitHub providers thread through as `sentry:…` / `datadog:…`
  // events. Each has its own stable identity for session coalescing.
  if (event.startsWith("sentry:")) {
    const issueId =
      readStringPath(root, ["data", "issue", "id"]) ??
      readStringPath(root, ["data", "event", "issue_id"]) ??
      readStringPath(root, ["data", "error", "issue_id"]) ??
      null;
    if (issueId) {
      return `sentry-issue-${issueId}`;
    }
    return null;
  }
  if (event.startsWith("datadog:")) {
    // Aggregation key groups all alerts in one monitor cycle; fall back to
    // monitor id so re-alerts on the same monitor coalesce.
    const aggreg = readStringPath(root, ["aggreg_key"]) ?? readStringPath(root, ["alert_cycle_key"]) ?? null;
    if (aggreg) {
      return `dd-${slugifyBranch(aggreg)}`;
    }
    const monitor =
      readStringPath(root, ["monitor_id"]) ??
      readStringPath(root, ["alert_id"]) ??
      readStringPath(root, ["id"]) ??
      null;
    if (monitor) {
      return `dd-monitor-${slugifyBranch(monitor)}`;
    }
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
    readStringPath(root, ["pull_request", "head", "ref"]) ??
    readStringPath(root, ["check_run", "check_suite", "head_branch"]) ??
    readStringPath(root, ["workflow_run", "head_branch"]) ??
    readStringPath(root, ["ref"])?.replace(/^refs\/heads\//, "") ??
    null;
  if (headRef) {
    const slug = slugifyBranch(headRef);
    if (slug) {
      return `branch-${slug}`;
    }
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
    readStringPath(root, ["data", "identifier"]) ??
    readStringPath(root, ["data", "issue", "identifier"]);
  if (linear && isLinearIdentifier(linear)) {
    return `lin-${linear.toLowerCase()}`;
  }

  return null;
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
  const repo = readStringPath(root, ["repository", "full_name"]) ?? undefined;
  const pr = pickPullRequest(event, root);
  const fullPr =
    typeof root.pull_request === "object" && root.pull_request !== null
      ? (root.pull_request as Record<string, unknown>)
      : pr;
  // The actor is the `sender` — the account that triggered the delivery,
  // i.e. who the action is on behalf of. (A GitHub App authors comments as
  // its own bot user under `comment.user`, but `sender` is the real actor.)
  const actor = readStringPath(root, ["sender", "login"]) ?? undefined;
  const prUrl = fullPr ? readStringPath(fullPr, ["html_url"]) : null;
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
 * Render the compact hook summary handed to the agent in the prompt.
 *
 * Thin alias over the DRY essentials layer (`shared/hookEssentials.ts`):
 * `buildHookEssentials` distills the payload, `renderHookEssentialsMarkdown`
 * formats it. All truncation limits + bot-noise suppression live there — this
 * keeps the old name working for the prompt formatter without a per-event
 * renderer here.
 */
export function renderHookSummaryMarkdown(event: string, payload: unknown): string {
  return renderHookEssentialsMarkdown(buildHookEssentials(event, payload));
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
