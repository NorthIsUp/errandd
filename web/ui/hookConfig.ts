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
  project: string[];
  level: string[];
  action: string[];
}

/** Mirror of src/hooks/schema.ts DatadogRule. */
export interface DatadogRule {
  monitor: string[];
  priority: string[];
  type: string[];
  tags: string[];
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
  /** When true (the default), drop events whose actor is the clawdcode
   *  user's own GitHub login — prevents a routine from retriggering
   *  itself. Render `skip_self: false` only when explicitly disabled. */
  skipSelf: boolean;
}

/** Best-effort defaults for a new Sentry rule (match any project). */
export function defaultSentryRule(): SentryRule {
  return { project: ["*"], level: [], action: [] };
}

/** Best-effort defaults for a new Datadog rule (match any monitor). */
export function defaultDatadogRule(): DatadogRule {
  return { monitor: ["*"], priority: [], type: [], tags: [] };
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
  }
  return { schedules, hookConfig };
}

// Mirrors src/hooks/schema.ts: Sentry triggers default to production
// projects only. `project: ["*"]` opts into all projects.
const PROD_SENTRY_PROJECT_PATTERNS = ["*-prod", "prod-*", "production"];

function parseSentry(raw: unknown): boolean | SentryRule {
  if (raw === true || raw === "true") {
    return { project: [...PROD_SENTRY_PROJECT_PATTERNS], level: [], action: [] };
  }
  if (raw === false || raw === "false" || raw === null || raw === undefined) return false;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      project:
        obj.project === undefined ? [...PROD_SENTRY_PROJECT_PATTERNS] : asList(obj.project),
      level: asList(obj.level),
      action: asList(obj.action),
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
