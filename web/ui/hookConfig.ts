/**
 * Client-side mirror of the `on:` hook-config schema.
 *
 * The server-side source of truth is `src/hooks/schema.ts`. Types and
 * defaults must stay in sync. We can't import that file from web because
 * it's wired into the daemon — so we mirror the shape here and re-parse
 * the YAML frontmatter on the client.
 */

import { parse as parseYaml } from "yaml";

export type DraftValue = boolean | "any";

export interface PrRule {
  repo: string | string[];
  user: string[];
  action: string[];
  branch: string[];
  labels: string[];
  draft: DraftValue;
}

interface CommentRule {
  /** Glob list matched against the commenter's login. Include/exclude
   *  via `!`-prefix mirrors PrRule.user. */
  user: string[];
}

/** Mirror of src/hooks/schema.ts SentryRule. */
export interface SentryRule {
  resource: string[];
  project: string[];
  environment: string[];
  level: string[];
  action: string[];
  host: string[];
  /** Fire only on the FIRST occurrence of an issue (re-occurrences stay quiet). */
  firstSeen: boolean;
  /** Defer a matched job by this many ms so a herd coalesces (0 = immediate). */
  debounceMs: number;
}

/** Mirror of src/hooks/schema.ts DatadogRule. */
export interface DatadogRule {
  monitor: string[];
  priority: string[];
  type: string[];
  tags: string[];
}

/** Mirror of src/hooks/schema.ts LinearRule. */
export interface LinearRule {
  type: string[];
  team: string[];
  action: string[];
  /** Priority-LABEL globs (Urgent/High/Normal/Low/None). Empty = any (lenient). */
  priority: string[];
  /** Workflow-state globs (Todo/In Progress/Done/…). Empty = any (lenient). */
  state: string[];
  /** Issue-label include/exclude globs (`bug`, `!wontfix`). Empty = any. */
  labels: string[];
  mention: boolean;
}

/** Mirror of src/hooks/schema.ts ChecksRule (CI/check webhooks). */
export interface ChecksRule {
  conclusion: string[];
  branch: string[];
  name: string[];
}

/** Mirror of src/hooks/schema.ts IssuesRule (plain `issues` event). */
export interface IssuesRule {
  action: string[];
  label: string[];
}

export interface HookConfig {
  pr: PrRule[];
  /** Fire on review/comment/suggestion events.
   *  - `true`              → any commenter (including bots)
   *  - `{ user: ["*"] }`   → same as `true`, in explicit form
   *  - `{ user: ["*", "!*[bot]"] }` → humans only
   *  - `{ user: ["*[bot]"] }`       → bots only
   */
  comments?: boolean | CommentRule;
  /** Fire on Sentry webhooks — `true` (any) or a filtered rule. */
  sentry?: boolean | SentryRule;
  /** Fire on Datadog webhooks — `true` (any) or a filtered rule. */
  datadog?: boolean | DatadogRule;
  /** Fire on Linear webhooks — `true` (any @mentioned Issue/Comment) or a rule. */
  linear?: boolean | LinearRule;
  /** Fire on GitHub CI/check webhooks — `true` (bad-CI default) or a filter. */
  checks?: boolean | ChecksRule;
  /** Fire on the plain GitHub `issues` event — `true` (opened) or a filter. */
  issues?: boolean | IssuesRule;
  /** When true (the default), drop events whose actor is the clawdcode
   *  user's own GitHub login — prevents a routine from retriggering
   *  itself. Render `skip_self: false` only when explicitly disabled. */
  skipSelf: boolean;
}

/** Best-effort defaults for a new Sentry rule: any project, prod environments
 *  only (the prod-only guard lives in `environment`, not the project slug). */
export function defaultSentryRule(): SentryRule {
  return {
    resource: ["issue", "error"],
    project: ["*"],
    environment: ["prod-*", "*-prod", "prod", "production"],
    level: [],
    action: [],
    host: [],
    firstSeen: false,
    debounceMs: 0,
  };
}

/** Best-effort defaults for a new Datadog rule (match any monitor). */
export function defaultDatadogRule(): DatadogRule {
  return { monitor: ["*"], priority: [], type: [], tags: [] };
}

/** Mirror of src/hooks/schema.ts: bad-CI conclusions (the safe checks default). */
export const DEFAULT_CHECKS_CONCLUSIONS = ["failure", "timed_out", "cancelled"];

/** Best-effort defaults for a new checks rule: fire on bad CI, any branch/name. */
export function defaultChecksRule(): ChecksRule {
  return { conclusion: [...DEFAULT_CHECKS_CONCLUSIONS], branch: [], name: [] };
}

/** Mirror of src/hooks/schema.ts: issues default action. */
export const DEFAULT_ISSUES_ACTIONS = ["opened"];

/** Best-effort defaults for a new issues rule: newly-opened issues, any label. */
export function defaultIssuesRule(): IssuesRule {
  return { action: [...DEFAULT_ISSUES_ACTIONS], label: [] };
}

export const DEFAULT_PR_ACTIONS = ["opened", "synchronize", "reopened"];

export const ALL_PR_ACTIONS = [
  "opened",
  "synchronize",
  "reopened",
  "closed",
  "edited",
  "labeled",
  "unlabeled",
  "ready_for_review",
  "converted_to_draft",
];

/** Best-effort defaults for a new rule. */
export function defaultPrRule(): PrRule {
  return {
    repo: "",
    user: ["*", "!*[bot]"],
    action: [...DEFAULT_PR_ACTIONS],
    branch: ["*"],
    labels: [],
    draft: false,
  };
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

export interface ParsedTriggers {
  /** Cron expressions from `- schedule:` entries (may be empty). */
  schedules: string[];
  /** Event triggers (pr/comments/sentry/datadog), or null when none. */
  hookConfig: HookConfig | null;
}

/**
 * Parse the `on:` triggers list out of a job's frontmatter into cron
 * schedules + a HookConfig. Each list item is a single-key dict:
 * `schedule` / `pr` / `prs` / `comments` / `sentry` / `datadog`. `skip_self`
 * is a top-level modifier. Best-effort: malformed items are skipped (the
 * editor falls back to defaults) rather than throwing.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one branch per trigger key.
export function parseTriggers(content: string): ParsedTriggers {
  const empty: ParsedTriggers = { schedules: [], hookConfig: null };
  const m = content.match(FRONTMATTER_RE);
  if (!m) return empty;
  let parsed: unknown;
  try {
    parsed = parseYaml(m[1] ?? "");
  } catch {
    return empty;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return empty;
  }
  const root = parsed as Record<string, unknown>;
  const skipSelf = !(root.skip_self === false || root.skip_self === "false");
  const on = root.on;
  if (!Array.isArray(on)) return { schedules: [], hookConfig: null };

  const schedules: string[] = [];
  const rules: PrRule[] = [];
  let comments: boolean | CommentRule = false;
  let sentry: boolean | SentryRule = false;
  let datadog: boolean | DatadogRule = false;
  let linear: boolean | LinearRule = false;
  let checks: boolean | ChecksRule = false;
  let issues: boolean | IssuesRule = false;
  let sawEvent = false;

  for (const item of on) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const keys = Object.keys(item as Record<string, unknown>);
    if (keys.length !== 1) continue;
    const key = keys[0] as string;
    const val = (item as Record<string, unknown>)[key];
    switch (key) {
      case "schedule":
        if (typeof val === "string" && val.trim()) schedules.push(val.trim());
        break;
      case "prs":
        if (val === true || val === "true") {
          rules.push(fullyOpenPrRule());
          sawEvent = true;
        }
        break;
      case "pr": {
        const rule = normalizeRule(val);
        if (rule) {
          rules.push(rule);
          sawEvent = true;
        }
        break;
      }
      case "comments":
        comments = parseComments(val);
        sawEvent = true;
        break;
      case "sentry":
        sentry = parseSentry(val);
        sawEvent = true;
        break;
      case "datadog":
        datadog = parseDatadog(val);
        sawEvent = true;
        break;
      case "linear":
        linear = parseLinear(val);
        sawEvent = true;
        break;
      case "checks":
        checks = parseChecks(val);
        sawEvent = true;
        break;
      case "issues":
        issues = parseIssues(val);
        sawEvent = true;
        break;
      default:
        break;
    }
  }

  let hookConfig: HookConfig | null = null;
  if (sawEvent) {
    hookConfig = { pr: rules, skipSelf };
    if (comments !== false) hookConfig.comments = comments;
    if (sentry !== false) hookConfig.sentry = sentry;
    if (datadog !== false) hookConfig.datadog = datadog;
    if (linear !== false) hookConfig.linear = linear;
    if (checks !== false) hookConfig.checks = checks;
    if (issues !== false) hookConfig.issues = issues;
  }
  return { schedules, hookConfig };
}

// Mirrors src/hooks/schema.ts: Sentry triggers default to any project but PROD
// ENVIRONMENTS only (the prod scope lives in environment, not the project slug).
// `environment: ["*"]` (or `[]`) opts into all environments.
const PROD_SENTRY_ENV_PATTERNS = ["prod-*", "*-prod", "prod", "production"];
const ERROR_SENTRY_RESOURCES = ["issue", "error"];

function parseSentry(raw: unknown): boolean | SentryRule {
  if (raw === true || raw === "true") {
    return {
      resource: [...ERROR_SENTRY_RESOURCES],
      project: ["*"],
      environment: [...PROD_SENTRY_ENV_PATTERNS],
      level: [],
      action: [],
      host: [],
      firstSeen: false,
      debounceMs: 0,
    };
  }
  if (raw === false || raw === "false" || raw === null || raw === undefined) return false;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const ms = typeof obj.debounceMs === "number" ? obj.debounceMs : Number(obj.debounceMs);
    return {
      resource: obj.resource === undefined ? [...ERROR_SENTRY_RESOURCES] : asList(obj.resource),
      project: obj.project === undefined ? ["*"] : asList(obj.project),
      environment:
        obj.environment === undefined ? [...PROD_SENTRY_ENV_PATTERNS] : asList(obj.environment),
      level: asList(obj.level),
      action: asList(obj.action),
      host: asList(obj.host),
      firstSeen: obj.firstSeen === true || obj.firstSeen === "true",
      debounceMs: Number.isFinite(ms) && ms > 0 ? ms : 0,
    };
  }
  return false;
}

function parseDatadog(raw: unknown): boolean | DatadogRule {
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false" || raw === null || raw === undefined) return false;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      monitor: obj.monitor === undefined ? ["*"] : asList(obj.monitor),
      priority: asList(obj.priority),
      type: asList(obj.type),
      tags: asList(obj.tags),
    };
  }
  return false;
}

/** Best-effort defaults for a new Linear rule: @mentioned Issue/Comment, any team.
 *  priority/state/labels default to any — the @mention gate is the safety. */
export function defaultLinearRule(): LinearRule {
  return {
    type: ["Issue", "Comment"],
    team: [],
    action: [],
    priority: [],
    state: [],
    labels: [],
    mention: true,
  };
}

function parseLinear(raw: unknown): boolean | LinearRule {
  if (raw === true || raw === "true") return defaultLinearRule();
  if (raw === false || raw === "false" || raw === null || raw === undefined) return false;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      type: obj.type === undefined ? ["Issue", "Comment"] : asList(obj.type),
      team: asList(obj.team),
      action: asList(obj.action),
      priority: asList(obj.priority),
      state: asList(obj.state),
      labels: asList(obj.labels),
      mention: obj.mention === undefined ? true : obj.mention !== false && obj.mention !== "false",
    };
  }
  return false;
}

function parseChecks(raw: unknown): boolean | ChecksRule {
  if (raw === true || raw === "true") return defaultChecksRule();
  if (raw === false || raw === "false" || raw === null || raw === undefined) return false;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      conclusion:
        obj.conclusion === undefined ? [...DEFAULT_CHECKS_CONCLUSIONS] : asList(obj.conclusion),
      branch: obj.branch === undefined ? [] : asList(obj.branch),
      name: obj.name === undefined ? [] : asList(obj.name),
    };
  }
  return false;
}

function parseIssues(raw: unknown): boolean | IssuesRule {
  if (raw === true || raw === "true") return defaultIssuesRule();
  if (raw === false || raw === "false" || raw === null || raw === undefined) return false;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      action: obj.action === undefined ? [...DEFAULT_ISSUES_ACTIONS] : asList(obj.action),
      label: obj.label === undefined ? [] : asList(obj.label),
    };
  }
  return false;
}

function parseComments(raw: unknown): boolean | CommentRule {
  if (raw === true || raw === "true") {
    return true;
  }
  if (raw === false || raw === "false" || raw === null || raw === undefined) {
    return false;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const user = asList(obj.user);
    if (user.length === 0) {
      return false;
    }
    return { user };
  }
  return false;
}

/** Shorthand-expanded "match any PR" rule. Stays in sync with the
 *  shorthand renderer in schedule.ts → renderOnBlock. */
function fullyOpenPrRule(): PrRule {
  return {
    repo: "*/*",
    user: ["*"],
    action: [...DEFAULT_PR_ACTIONS],
    branch: ["!main"],
    labels: [],
    draft: false,
  };
}

function normalizeRule(raw: unknown): PrRule | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const repo = asStringOrList(obj.repo) ?? "";
  const user = asList(obj.user);
  const action = obj.action === undefined ? [...DEFAULT_PR_ACTIONS] : asList(obj.action);
  const branch = obj.branch === undefined ? ["*"] : asList(obj.branch);
  const labels = obj.labels === undefined ? [] : asList(obj.labels);
  let draft: DraftValue = false;
  const d = obj.draft;
  if (d === true || d === "true") {
    draft = true;
  } else if (d === "any") {
    draft = "any";
  }
  return { repo, user, action, branch, labels, draft };
}

function asStringOrList(v: unknown): string | string[] | null {
  if (typeof v === "string") {
    return v;
  }
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    return v as string[];
  }
  return null;
}

function asList(v: unknown): string[] {
  if (v === undefined || v === null) {
    return [];
  }
  if (typeof v === "string") {
    return [v];
  }
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string");
  }
  return [];
}

// ===========================================================================
// The simple GitHub-triggers model — browser-safe mirror of the block in
// `src/hooks/schema.ts`. The v3 editor imports THIS file (the daemon schema
// can't be bundled into the browser). Keep the two copies in sync; the
// round-trip tests on both sides guard against drift.
// ===========================================================================

export interface GitHubAdvanced {
  /** Base-branch globs for the PR-updates rule (default `["!main"]`). */
  base: string[];
  /** Required/excluded PR labels (default `[]`). */
  labels: string[];
  /** Draft handling: false = skip drafts, true = drafts only, "any" = both. */
  draft: DraftValue;
  /** Repo globs (default any repo). */
  repo: string[];
}

export interface GitHubTriggers {
  humans: { prUpdates: boolean; comments: boolean };
  bots: { prUpdates: boolean; comments: boolean };
  advanced: GitHubAdvanced;
  /** skip_self modifier (default true). */
  skipSelf: boolean;
}

export function defaultGitHubAdvanced(): GitHubAdvanced {
  return { base: ["!main"], labels: [], draft: false, repo: ["*/*"] };
}

/** Easy defaults for a NEW GitHub routine: respond to humans (PR updates +
 *  comments), ignore bot noise, skip self. */
export function defaultGitHubTriggers(): GitHubTriggers {
  return {
    humans: { prUpdates: true, comments: true },
    bots: { prUpdates: false, comments: false },
    advanced: defaultGitHubAdvanced(),
    skipSelf: true,
  };
}

/** Actor-class → `user` glob list. Both (or neither) → anyone; a single class
 *  narrows. Single source for the matrix ↔ glob mapping. */
export function classGlob(humans: boolean, bots: boolean): string[] {
  if ((humans && bots) || !(humans || bots)) return ["*"];
  if (humans) return ["*", "!*[bot]"];
  return ["*[bot]"];
}

/** A recognized class glob → which actor classes it selects, or null when the
 *  glob is bespoke and the simple matrix can't represent it. */
export function authorsFromGlob(user: string[]): { humans: boolean; bots: boolean } | null {
  if (user.length === 1 && user[0] === "*") return { humans: true, bots: true };
  if (user.length === 2 && user[0] === "*" && user[1] === "!*[bot]") {
    return { humans: true, bots: false };
  }
  if (user.length === 1 && user[0] === "*[bot]") return { humans: false, bots: true };
  return null;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

/**
 * Project the simple matrix down to a HookConfig. Returns `null` when no GitHub
 * trigger is selected (both categories off). The matrix owns ONLY `pr` /
 * `comments` / `skipSelf`; the caller must preserve any pre-existing
 * `sentry` / `datadog` (merge, not replace).
 */
export function gitHubTriggersToHookConfig(m: GitHubTriggers): HookConfig | null {
  const pr: PrRule[] = [];
  const prHumans = m.humans.prUpdates;
  const prBots = m.bots.prUpdates;
  if (prHumans || prBots) {
    pr.push({
      repo: m.advanced.repo.length === 1 ? (m.advanced.repo[0] as string) : [...m.advanced.repo],
      user: classGlob(prHumans, prBots),
      action: [...DEFAULT_PR_ACTIONS],
      branch: [...m.advanced.base],
      labels: [...m.advanced.labels],
      draft: m.advanced.draft,
    });
  }

  let comments: HookConfig["comments"];
  const cHumans = m.humans.comments;
  const cBots = m.bots.comments;
  if (cHumans || cBots) {
    comments = cHumans && cBots ? true : { user: classGlob(cHumans, cBots) };
  }

  if (pr.length === 0 && comments === undefined) return null;

  const cfg: HookConfig = { pr, skipSelf: m.skipSelf };
  if (comments !== undefined) cfg.comments = comments;
  return cfg;
}

/**
 * Project a HookConfig up to the simple matrix, plus a `representable` flag.
 * Non-representable configs (>1 PR rule, non-default actions, bespoke globs,
 * or a sentry/datadog block) must fall back to raw YAML editing.
 */
export function hookConfigToGitHubTriggers(cfg: HookConfig | null): {
  matrix: GitHubTriggers;
  representable: boolean;
} {
  const matrix = defaultGitHubTriggers();
  matrix.humans = { prUpdates: false, comments: false };
  matrix.bots = { prUpdates: false, comments: false };

  if (!cfg) {
    return { matrix, representable: true };
  }

  matrix.skipSelf = cfg.skipSelf !== false;
  let representable =
    cfg.sentry === undefined &&
    cfg.datadog === undefined &&
    cfg.linear === undefined &&
    cfg.checks === undefined &&
    cfg.issues === undefined;

  if (cfg.pr.length > 1) representable = false;
  const rule = cfg.pr[0];
  if (rule) {
    if (!sameSet(rule.action, DEFAULT_PR_ACTIONS)) representable = false;
    const classes = authorsFromGlob(rule.user);
    if (classes) {
      matrix.humans.prUpdates = classes.humans;
      matrix.bots.prUpdates = classes.bots;
    } else {
      representable = false;
      matrix.humans.prUpdates = true;
      matrix.bots.prUpdates = true;
    }
    matrix.advanced = {
      base: [...rule.branch],
      labels: [...rule.labels],
      draft: rule.draft,
      repo: Array.isArray(rule.repo) ? [...rule.repo] : [rule.repo],
    };
  }

  const c = cfg.comments;
  if (c === true) {
    matrix.humans.comments = true;
    matrix.bots.comments = true;
  } else if (c && typeof c === "object") {
    const classes = authorsFromGlob(c.user);
    if (classes) {
      matrix.humans.comments = classes.humans;
      matrix.bots.comments = classes.bots;
    } else {
      representable = false;
      matrix.humans.comments = true;
      matrix.bots.comments = true;
    }
  }

  return { matrix, representable };
}

/** Plain-English readout of the matrix for the editor's summary line. */
export function summarizeGitHubTriggers(m: GitHubTriggers): string {
  const cat = (humans: boolean, bots: boolean): string | null => {
    if (humans && bots) return "anyone";
    if (humans) return "humans";
    if (bots) return "bots";
    return null;
  };
  const prActor = cat(m.humans.prUpdates, m.bots.prUpdates);
  const commentActor = cat(m.humans.comments, m.bots.comments);

  const clauses: string[] = [];
  if (prActor && commentActor && prActor === commentActor) {
    clauses.push(`PR updates and comments from ${prActor}`);
  } else {
    if (prActor) clauses.push(`PR updates from ${prActor}`);
    if (commentActor) clauses.push(`comments from ${commentActor}`);
  }
  if (clauses.length === 0) return "No GitHub triggers.";

  let line = `Fires on ${clauses.join(" and ")}.`;

  const extras: string[] = [];
  const adv = m.advanced;
  const base = adv.base;
  const baseDefault = base.length === 1 && base[0] === "!main";
  if ((m.humans.prUpdates || m.bots.prUpdates) && !baseDefault && base.length > 0) {
    extras.push(`targeting ${base.join(", ")}`);
  }
  if (adv.labels.length > 0) extras.push(`labels ${adv.labels.join(", ")}`);
  if (adv.draft === true) extras.push("drafts only");
  else if (adv.draft === "any") extras.push("incl. drafts");
  if (extras.length > 0) line += ` · ${extras.join(" · ")}`;
  return line;
}
