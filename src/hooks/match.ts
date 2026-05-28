/**
 * Match a parsed GitHub webhook payload against a HookConfig.
 *
 * Glob semantics (see PR_HOOKS_SPEC.md):
 *   - Patterns are evaluated in order, case-insensitively.
 *   - A bare pattern includes; a `!`-prefixed pattern excludes.
 *   - State starts at "not included" and flips per match.
 */

import type { PrRule } from "./schema";

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
  let included = false;
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
 * Returns null when no useful scope can be extracted — the caller should
 * fall back to per-run thread IDs in that case.
 *
 * The scope is intentionally `pr-<number>-<branch-slug>` rather than just
 * `pr-<number>`: the branch slug makes the scope human-readable in logs and
 * UI ("the agent working on feature-foo"), and the number guarantees
 * uniqueness even if branches are reused.
 */
export function extractHookScope(event: string, payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const root = payload as Record<string, unknown>;

  const pr = pickPullRequest(event, root);
  if (pr) {
    const number = typeof pr.number === "number" ? pr.number : null;
    const branch = readPath(pr, ["head", "ref"]);
    if (number !== null) {
      const slug = branch ? slugifyBranch(branch) : "";
      return slug ? `pr-${number}-${slug}` : `pr-${number}`;
    }
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
