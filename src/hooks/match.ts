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
