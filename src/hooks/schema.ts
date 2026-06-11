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

export interface PrRule {
  repo: string | string[];
  user: string[]; // required, but we'll surface a clearer error if missing
  action: string[];
  branch: string[];
  labels: string[];
  draft: boolean | "any";
}

export interface CommentRule {
  /** Glob list (include/exclude semantics same as PrRule.user) matched
   *  against the commenter's GitHub login. */
  user: string[];
}

/**
 * Match Sentry integration-platform webhooks. Fields are glob lists with
 * the same include/exclude semantics as PrRule (`!`-prefix excludes).
 * `true` is the "match any Sentry event" shorthand.
 */
export interface SentryRule {
  /** Sentry webhook resource-type globs (`issue`, `error`, `comment`, `seer`,
   *  `preprod_artifact`). The default is errors only — `issue`/`error` — since
   *  `action: created` alone can't tell an error from a comment. Empty = any. */
  resource: string[];
  /** Sentry project slug globs (e.g. `["clara-backend", "javascript-*"]`).
   *  Empty/`["*"]` = any project. */
  project: string[];
  /** Environment globs (`production`, `prod-*`, …). The "prod-only" intent
   *  lives HERE, not in the project slug (projects like `clara-backend` aren't
   *  named for their env). Empty = any environment. */
  environment: string[];
  /** Issue level globs (`error`, `warning`, `fatal`, `info`, `debug`). */
  level: string[];
  /** Resource action globs (`created`, `resolved`, `ignored`, `assigned`,
   *  `triggered`). Empty = any. */
  action: string[];
}

/**
 * Match Datadog webhooks. Datadog payloads are user-defined, so matching
 * keys off the canonical template fields clawdcode recommends configuring
 * in the Datadog webhook payload (monitor id, alert type, priority, tags).
 */
export interface DatadogRule {
  /** Monitor / event id globs. */
  monitor: string[];
  /** Alert priority globs (`P1`…`P5`, `normal`). */
  priority: string[];
  /** Alert type / transition globs (`error`, `warning`, `success`,
   *  `recovery`, `no data`). */
  type: string[];
  /** Tag globs matched against the `$TAGS` list (e.g. `service:api`). */
  tags: string[];
}

/**
 * Match Linear webhooks. Linear webhooks carry an entity `type` (Issue,
 * Comment, …), an `action` (create/update/remove), and a team. The common case
 * is "a ticket/comment that @mentions the bot", so `mention` defaults on.
 */
export interface LinearRule {
  /** Entity-type globs (`Issue`, `Comment`, `Project`, …). Empty = any. Matched
   *  case-insensitively. */
  type: string[];
  /** Team-key globs (`ENG`, `CLA-*`). Empty = any team. */
  team: string[];
  /** Action globs (`create`, `update`, `remove`). Empty = any. */
  action: string[];
  /** Require the ticket/comment to @mention the bot (the "@mention me" use
   *  case). Default true; set false to fire on any matching event. */
  mention: boolean;
}

export interface HookConfig {
  pr: PrRule[];
  /** Fire on review/comment/suggestion events across the whole tailnet's
   *  repos. Triggers on `issue_comment`, `pull_request_review`, and
   *  `pull_request_review_comment`.
   *
   *  - `true` (or `{ user: ["*"] }`) → any commenter, including bots
   *  - `{ user: ["*", "!*[bot]"] }` → humans only
   *  - `{ user: ["*[bot]"] }`       → bots only
   *  - `false` / unset              → don't fire on comments
   */
  comments?: boolean | CommentRule;
  /** Fire on Sentry webhooks. `true` = any Sentry event; an object filters
   *  by project / level / action. Unset = don't fire on Sentry. */
  sentry?: boolean | SentryRule;
  /** Fire on Datadog webhooks. `true` = any Datadog event; an object
   *  filters by monitor / priority / type / tags. Unset = off. */
  datadog?: boolean | DatadogRule;
  /** Fire on Linear webhooks. `true` = any @mentioned Issue/Comment; an object
   *  filters by type / team / action and toggles the @mention gate. Unset = off. */
  linear?: boolean | LinearRule;
  /** Drop events where the actor matches the clawdcode user's own GitHub
   *  login — so a routine that comments on a PR doesn't get retriggered
   *  by its own comment. Defaults to `true`; explicit `false` allows
   *  self-retrigger (useful for testing or self-replay scenarios). The
   *  daemon resolves "self" via `gh api user --jq .login` at startup. */
  skipSelf: boolean;
}

export interface ParsedTriggers {
  /** Cron expressions from `- schedule:` entries (may be empty). */
  schedules: string[];
  /** Event triggers (pr/comments/sentry/datadog), or null when none. */
  hookConfig: HookConfig | null;
}

/**
 * Parse the `on:` LIST from a job's frontmatter into cron schedules plus a
 * normalized HookConfig. Each list item is a single-key dict naming one
 * trigger: `schedule`, `pr`, `prs`, `comments`, `sentry`, or `datadog`.
 *
 * `skipSelf` comes from the top-level `skip_self:` key (it's a modifier, not
 * a trigger). Returns `hookConfig: null` when there are no event triggers, so
 * a pure-cron routine isn't given an empty hookConfig (which would make the
 * one-shot finally-clause wrongly treat it as event-driven).
 *
 * Throws with a descriptive message on a malformed list (non-list `on:`,
 * multi-key items, unknown trigger keys) so typos surface instead of
 * silently never firing.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one branch per supported trigger key.
export function parseTriggers(rawOn: unknown, topLevelSkipSelf: unknown): ParsedTriggers {
  // skip_self defaults true; only an explicit false disables it. Tolerant of
  // both YAML boolean false and the string "false".
  const skipSelf = !(topLevelSkipSelf === false || topLevelSkipSelf === "false");

  if (rawOn === null || rawOn === undefined) {
    return { schedules: [], hookConfig: null };
  }
  if (!Array.isArray(rawOn)) {
    throw new Error(`\`on:\` must be a list of single-key triggers (got ${typeName(rawOn)})`);
  }

  const schedules: string[] = [];
  const prRules: PrRule[] = [];
  let comments: boolean | CommentRule = false;
  let sentry: boolean | SentryRule = false;
  let datadog: boolean | DatadogRule = false;
  let linear: boolean | LinearRule = false;
  let sawEventTrigger = false;

  for (let i = 0; i < rawOn.length; i++) {
    const item = rawOn[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(
        `on[${i}]: each trigger must be a single-key mapping (got ${typeName(item)})`,
      );
    }
    const keys = Object.keys(item as Record<string, unknown>);
    if (keys.length !== 1) {
      throw new Error(`on[${i}]: each trigger must have exactly one key, got [${keys.join(", ")}]`);
    }
    const key = keys[0] as string;
    const val = (item as Record<string, unknown>)[key];
    switch (key) {
      case "schedule": {
        if (val !== null && val !== undefined && typeof val !== "string") {
          throw new Error(`on[${i}].schedule: must be a cron string (got ${typeName(val)})`);
        }
        const cron = (val ?? "").toString().trim();
        if (cron) schedules.push(cron);
        break;
      }
      case "prs":
        sawEventTrigger = true;
        if (val === true || val === "true") {
          prRules.push(fullyOpenPrRule());
        } else {
          throw new Error(`on[${i}].prs: only \`true\` is supported (use \`pr:\` for filters)`);
        }
        break;
      case "pr":
        sawEventTrigger = true;
        try {
          prRules.push(normalizePrRule(val));
        } catch (e) {
          throw new Error(`on[${i}].pr: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      case "comments":
        sawEventTrigger = true;
        comments = parseComments(val);
        break;
      case "sentry":
        sawEventTrigger = true;
        sentry = parseSentry(val);
        break;
      case "datadog":
        sawEventTrigger = true;
        datadog = parseDatadog(val);
        break;
      case "linear":
        sawEventTrigger = true;
        linear = parseLinear(val);
        break;
      default:
        throw new Error(`on[${i}]: unknown trigger \`${key}\``);
    }
  }

  let hookConfig: HookConfig | null = null;
  if (sawEventTrigger) {
    hookConfig = { pr: prRules, skipSelf };
    if (comments !== false) hookConfig.comments = comments;
    if (sentry !== false) hookConfig.sentry = sentry;
    if (datadog !== false) hookConfig.datadog = datadog;
    if (linear !== false) hookConfig.linear = linear;
  }
  return { schedules, hookConfig };
}

/** Default project allowlist for Sentry triggers: production projects only.
 *  Matched with `matchPatternList` globs against the payload project slug, so
 *  this covers `clara-prod`, `prod-api`, `production`, etc. — but not staging
 *  or dev. Opt into everything with an explicit `project: ["*"]`. */
/** Default ENVIRONMENT globs for a bare `on: - sentry` — the "prod-only" guard.
 *  Sentry environments are named for the deploy (`production`, `prod-v1`,
 *  `clara-prod`), so this is where prod-scoping belongs (not the project slug). */
export const PROD_SENTRY_ENV_PATTERNS = ["prod-*", "*-prod", "prod", "production"];

/** Default RESOURCE types for a bare `on: - sentry`: errors only. `action`
 *  globs (`created`, …) are shared across resources, so without this a routine
 *  would also fire on comment / seer / preprod_artifact webhooks. */
export const ERROR_SENTRY_RESOURCES = ["issue", "error"];

/** A Sentry rule that matches ANY project but only PROD environments, with no
 *  level/action filter — what a bare `on: - sentry: true` (or `{}`) resolves to.
 *  The prod-only guard lives in `environment`, so it works across projects whose
 *  slugs aren't named for their env (e.g. `clara-backend`). */
export function defaultSentryRule(): SentryRule {
  return {
    resource: [...ERROR_SENTRY_RESOURCES],
    project: ["*"],
    environment: [...PROD_SENTRY_ENV_PATTERNS],
    level: [],
    action: [],
  };
}

/** Parse `on.sentry`. `true` / `{}` → any project, prod environments (the safe
 *  default); object with explicit fields → that filter (use `environment: ["*"]`
 *  or `[]` for all envs); unset / false → off (returns false). */
function parseSentry(raw: unknown): boolean | SentryRule {
  if (raw === true || raw === "true") return defaultSentryRule();
  if (raw === false || raw === "false" || raw === null || raw === undefined) return false;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      resource: obj.resource === undefined ? [...ERROR_SENTRY_RESOURCES] : asList(obj.resource),
      project: obj.project === undefined ? ["*"] : asList(obj.project),
      environment:
        obj.environment === undefined ? [...PROD_SENTRY_ENV_PATTERNS] : asList(obj.environment),
      level: obj.level === undefined ? [] : asList(obj.level),
      action: obj.action === undefined ? [] : asList(obj.action),
    };
  }
  throw new Error(`\`on.sentry\` must be a boolean or a mapping, got ${typeName(raw)}`);
}

/** Default priority floor for Datadog triggers: alert/warning priorities only.
 *  Datadog monitors fire at P1–P5 plus `normal`/info noise; the safe default is
 *  to require a real alert priority so a bare `on: - datadog: true` doesn't fan
 *  out an agent run on every low-priority/`normal` event (denial-of-wallet).
 *  Matched with `matchPatternList` globs against the payload priority. Opt into
 *  everything with an explicit `priority: ["*"]`. */
export const DEFAULT_DATADOG_PRIORITY_PATTERNS = ["P1", "P2", "P3"];

/** A Datadog rule with the priority-floor default and no monitor/type/tag
 *  filter — what a bare `on: - datadog: true` (or `{}`) resolves to. Mirrors
 *  defaultSentryRule: `true` must not match every alert (P0-4). */
export function defaultDatadogRule(): DatadogRule {
  return {
    monitor: ["*"],
    priority: [...DEFAULT_DATADOG_PRIORITY_PATTERNS],
    type: [],
    tags: [],
  };
}

/** Parse `on.datadog`. `true` / `{}` → priority-floor default (the safe
 *  default); object with explicit `priority` → that filter (use `["*"]` for
 *  all priorities); unset / false → off. Same shape rules as parseSentry. */
function parseDatadog(raw: unknown): boolean | DatadogRule {
  if (raw === true || raw === "true") return defaultDatadogRule();
  if (raw === false || raw === "false" || raw === null || raw === undefined) return false;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      monitor: obj.monitor === undefined ? ["*"] : asList(obj.monitor),
      priority:
        obj.priority === undefined ? [...DEFAULT_DATADOG_PRIORITY_PATTERNS] : asList(obj.priority),
      type: obj.type === undefined ? [] : asList(obj.type),
      tags: obj.tags === undefined ? [] : asList(obj.tags),
    };
  }
  throw new Error(`\`on.datadog\` must be a boolean or a mapping, got ${typeName(raw)}`);
}

/** Default Linear entity types for a bare `on: - linear`: the actionable ones. */
export const DEFAULT_LINEAR_TYPES = ["Issue", "Comment"];

/** A Linear rule matching @mentioned Issue/Comment on any team — what a bare
 *  `on: - linear: true` (or `{}`) resolves to. */
export function defaultLinearRule(): LinearRule {
  return { type: [...DEFAULT_LINEAR_TYPES], team: [], action: [], mention: true };
}

/** Parse `on.linear`. `true` / `{}` → @mentioned Issue/Comment, any team (the
 *  safe default); object with explicit fields → that filter (set `mention: false`
 *  to fire on any event, `type: ["*"]` for all entity types); unset / false → off. */
function parseLinear(raw: unknown): boolean | LinearRule {
  if (raw === true || raw === "true") return defaultLinearRule();
  if (raw === false || raw === "false" || raw === null || raw === undefined) return false;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      type: obj.type === undefined ? [...DEFAULT_LINEAR_TYPES] : asList(obj.type),
      team: obj.team === undefined ? [] : asList(obj.team),
      action: obj.action === undefined ? [] : asList(obj.action),
      mention: obj.mention === undefined ? true : obj.mention !== false && obj.mention !== "false",
    };
  }
  throw new Error(`\`on.linear\` must be a boolean or a mapping, got ${typeName(raw)}`);
}

/** Normalize the `on.comments` field. Accepts:
 *  - `true` / `"true"`     → all commenters (treat as boolean true)
 *  - `false` / unset       → off (return false)
 *  - `{ user: [...] }`     → filter by user globs
 *  Returns `false` for off, `true` for unfiltered, or a CommentRule. */
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
      throw new Error("`on.comments.user` must list at least one glob");
    }
    return { user };
  }
  throw new Error(`\`on.comments\` must be a boolean or { user: [...] }, got ${typeName(raw)}`);
}

function fullyOpenPrRule(): PrRule {
  return {
    repo: "*/*",
    user: ["*"],
    action: [...DEFAULT_PR_ACTIONS],
    // Skip PRs targeting main — release/landing PRs are usually noise
    // for code-review automation. Users can override by writing the
    // expanded `pr:` form.
    branch: ["!main"],
    labels: [],
    draft: false,
  };
}

/**
 * Canonical "PR updates" action set. The simple GitHub-triggers matrix treats
 * created/opened ≈ updated/synchronize/reopened as ONE "PR updates" category,
 * and this is the action list a simple-matrix PR rule always carries. Single
 * source of truth — the matrix references it, never re-spells it.
 */
export const DEFAULT_PR_ACTIONS = ["opened", "synchronize", "reopened"];

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

// ===========================================================================
// The simple GitHub-triggers model: a 2×2 (actor-class × category) matrix that
// is a lossless *view* over a HookConfig. `HookConfig` stays the on-disk / wire
// source of truth; `GitHubTriggers` is derived on load and projected back on
// save. The mapping is DRY and bidirectional; non-representable (power-user)
// configs fall back to raw editing.
//
// This block is mirrored byte-for-byte (type + the two mapping fns + glob
// helpers + the summary) in `web/ui/hookConfig.ts`, which the v3 editor imports
// (the daemon `schema.ts` can't be bundled into the browser). Keep them in sync.
// ===========================================================================

/** Advanced (collapsed-by-default) fields on the simple matrix. Empty/default
 *  values mean the simple 2×2 grid fully describes the config. */
export interface GitHubAdvanced {
  /** Base-branch globs for the PR-updates rule (default `["!main"]`). */
  base: string[];
  /** Required/excluded PR labels (default `[]`). */
  labels: string[];
  /** Draft handling: false = skip drafts, true = drafts only, "any" = both. */
  draft: boolean | "any";
  /** Repo globs (default any repo). */
  repo: string[];
}

/**
 * The simple GitHub-triggers matrix. Two actor classes (humans / bots) crossed
 * with two categories (PR updates / Comments), plus collapsed Advanced fields
 * and the `skip_self` modifier.
 */
export interface GitHubTriggers {
  humans: { prUpdates: boolean; comments: boolean };
  bots: { prUpdates: boolean; comments: boolean };
  advanced: GitHubAdvanced;
  /** skip_self modifier (default true). */
  skipSelf: boolean;
}

/** The advanced defaults a brand-new / PR-less matrix carries. */
export function defaultGitHubAdvanced(): GitHubAdvanced {
  return { base: ["!main"], labels: [], draft: false, repo: ["*/*"] };
}

/**
 * Easy defaults for a NEW GitHub routine: respond to humans (PR updates +
 * comments), ignore bot noise, skip self. Maps to a humans-only PR rule on
 * non-main branches + a humans-only comments rule.
 */
export function defaultGitHubTriggers(): GitHubTriggers {
  return {
    humans: { prUpdates: true, comments: true },
    bots: { prUpdates: false, comments: false },
    advanced: defaultGitHubAdvanced(),
    skipSelf: true,
  };
}

/** Actor-class → `user` glob list. Both (or neither) → anyone; a single class
 *  narrows. Single source for the matrix ↔ glob mapping (mirrors the old
 *  `authorsToGlob` in HookConfigEditor.tsx). */
export function classGlob(humans: boolean, bots: boolean): string[] {
  if ((humans && bots) || !(humans || bots)) return ["*"];
  if (humans) return ["*", "!*[bot]"];
  return ["*[bot]"];
}

/** A recognized class glob → which actor classes it selects, or null when the
 *  glob is something bespoke the simple matrix can't represent. */
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
 * Project the simple matrix down to a HookConfig (the wire/disk form). Returns
 * `null` when no GitHub trigger is selected at all (both categories off) so the
 * caller drops the `on:` block — matching the "empty → no block" contract.
 *
 * The matrix owns ONLY `pr` / `comments` / `skipSelf`; the caller is
 * responsible for preserving any pre-existing `sentry` / `datadog` (merge, not
 * replace).
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
 *
 * The config is representable iff: at most one PR rule whose `action` is the
 * default set and whose `user` is one of the three recognized class globs; the
 * `comments` field is off / `true` / a class-glob `{ user }`; and there is no
 * `sentry` / `datadog` block (those have no place in the simple grid). When
 * NOT representable, the matrix is returned best-effort (for display) but the
 * editor must fall back to raw YAML editing rather than projecting back.
 */
export function hookConfigToGitHubTriggers(cfg: HookConfig | null): {
  matrix: GitHubTriggers;
  representable: boolean;
} {
  const matrix = defaultGitHubTriggers();
  // Start from a clean slate (defaults are "humans on"); we set bits from cfg.
  matrix.humans = { prUpdates: false, comments: false };
  matrix.bots = { prUpdates: false, comments: false };

  if (!cfg) {
    return { matrix, representable: true };
  }

  matrix.skipSelf = cfg.skipSelf !== false;
  let representable =
    cfg.sentry === undefined && cfg.datadog === undefined && cfg.linear === undefined;

  // --- PR rules ---
  if (cfg.pr.length > 1) {
    representable = false;
  }
  const rule = cfg.pr[0];
  if (rule) {
    if (!sameSet(rule.action, DEFAULT_PR_ACTIONS)) representable = false;
    const classes = authorsFromGlob(rule.user);
    if (classes) {
      matrix.humans.prUpdates = classes.humans;
      matrix.bots.prUpdates = classes.bots;
    } else {
      representable = false;
      // Best-effort display: treat an unknown glob as "anyone".
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

  // --- comments ---
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
  // Combine when both categories share the same actor class.
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
