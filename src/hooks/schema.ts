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
  /** Sentry project slug globs (e.g. `["clara-prod-*", "!staging"]`). */
  project: string[];
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
  let sawEventTrigger = false;

  for (let i = 0; i < rawOn.length; i++) {
    const item = rawOn[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`on[${i}]: each trigger must be a single-key mapping (got ${typeName(item)})`);
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
  }
  return { schedules, hookConfig };
}

/** Default project allowlist for Sentry triggers: production projects only.
 *  Matched with `matchPatternList` globs against the payload project slug, so
 *  this covers `clara-prod`, `prod-api`, `production`, etc. — but not staging
 *  or dev. Opt into everything with an explicit `project: ["*"]`. */
export const PROD_SENTRY_PROJECT_PATTERNS = ["*-prod", "prod-*", "production"];

/** A Sentry rule with the prod-only project default and no level/action
 *  filter — what a bare `on: - sentry: true` (or `{}`) resolves to. */
export function defaultSentryRule(): SentryRule {
  return { project: [...PROD_SENTRY_PROJECT_PATTERNS], level: [], action: [] };
}

/** Parse `on.sentry`. `true` / `{}` → prod projects only (the safe default);
 *  object with explicit `project` → that filter (use `["*"]` for all
 *  projects); unset / false → off (returns false). */
function parseSentry(raw: unknown): boolean | SentryRule {
  if (raw === true || raw === "true") return defaultSentryRule();
  if (raw === false || raw === "false" || raw === null || raw === undefined) return false;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      project:
        obj.project === undefined ? [...PROD_SENTRY_PROJECT_PATTERNS] : asList(obj.project),
      level: obj.level === undefined ? [] : asList(obj.level),
      action: obj.action === undefined ? [] : asList(obj.action),
    };
  }
  throw new Error(`\`on.sentry\` must be a boolean or a mapping, got ${typeName(raw)}`);
}

/** Parse `on.datadog`. Same shape rules as parseSentry. */
function parseDatadog(raw: unknown): boolean | DatadogRule {
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false" || raw === null || raw === undefined) return false;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      monitor: obj.monitor === undefined ? ["*"] : asList(obj.monitor),
      priority: obj.priority === undefined ? [] : asList(obj.priority),
      type: obj.type === undefined ? [] : asList(obj.type),
      tags: obj.tags === undefined ? [] : asList(obj.tags),
    };
  }
  throw new Error(`\`on.datadog\` must be a boolean or a mapping, got ${typeName(raw)}`);
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
