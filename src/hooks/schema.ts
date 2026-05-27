/**
 * Schema for the `on:` block inside a job's YAML frontmatter.
 *
 *   on:
 *     pr:
 *       repo: org/repo            # or [org/repo, org/other]
 *       user: ["*", "!*[bot]"]    # include/exclude globs, evaluated in order
 *       action: [opened, synchronize, reopened]
 *       branch: [main, !release/*]
 *       labels: [ready-for-review]
 *       draft: false              # false (default), true, or "any"
 *
 * Defaults are picked to be safe-by-default:
 *  - `user` has no default — a rule with no user list never matches, so
 *    forks from random accounts don't trigger jobs.
 *  - `action` defaults to common write events.
 *  - `draft` defaults to false (skip drafts).
 */

export type StringOrList = string | string[];

export interface PrRule {
  repo: string | string[];
  user: string[]; // required, but we'll surface a clearer error if missing
  action: string[];
  branch: string[];
  labels: string[];
  draft: boolean | "any";
}

export interface HookConfig {
  pr: PrRule[];
}

/**
 * Parse the raw `on` value from a job's frontmatter into a normalized
 * HookConfig. Returns null if there's no `on:` block. Throws with a
 * descriptive message if the block is malformed.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: shape-validation has a branch per supported field.
export function parseHookConfig(raw: unknown): HookConfig | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`\`on:\` must be a mapping (got ${typeName(raw)})`);
  }
  const obj = raw as Record<string, unknown>;
  const pr = obj.pr;
  const prRules: PrRule[] = [];
  if (pr !== undefined) {
    const list = Array.isArray(pr) ? pr : [pr];
    for (let i = 0; i < list.length; i++) {
      try {
        prRules.push(normalizePrRule(list[i]));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`on.pr[${i}]: ${msg}`);
      }
    }
  }
  return { pr: prRules };
}

const DEFAULT_PR_ACTIONS = ["opened", "synchronize", "reopened"];

function normalizePrRule(raw: unknown): PrRule {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`expected a mapping (got ${typeName(raw)})`);
  }
  const obj = raw as Record<string, unknown>;
  const repo = requireStringOrList(obj.repo, "repo");
  const user = asList(obj.user);
  if (user.length === 0) {
    throw new Error(
      '`user:` is required and must list at least one glob (use `["*", "!*[bot]"]` ' +
        "for everyone except bots — but be careful on public repos)",
    );
  }
  const action = obj.action === undefined ? DEFAULT_PR_ACTIONS : asList(obj.action);
  const branch = obj.branch === undefined ? ["*"] : asList(obj.branch);
  const labels = obj.labels === undefined ? [] : asList(obj.labels);
  const draftRaw = obj.draft;
  let draft: boolean | "any" = false;
  if (draftRaw === true || draftRaw === "true") {
    draft = true;
  } else if (draftRaw === "any") {
    draft = "any";
  }
  return { repo, user, action, branch, labels, draft };
}

function requireStringOrList(v: unknown, key: string): string | string[] {
  if (typeof v === "string") {
    return v;
  }
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    return v as string[];
  }
  throw new Error(`\`${key}:\` must be a string or list of strings`);
}

function asList(v: unknown): string[] {
  if (v === undefined) {
    return [];
  }
  if (typeof v === "string") {
    return [v];
  }
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    return v as string[];
  }
  throw new Error("expected a string or list of strings");
}

function typeName(v: unknown): string {
  if (v === null) {
    return "null";
  }
  if (Array.isArray(v)) {
    return "list";
  }
  return typeof v;
}
