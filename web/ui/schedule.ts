/**
 * Schedule helpers — preset table, frequency ↔ cron conversion, simple
 * next-run prediction, and frontmatter (de)serialization for job .md files.
 *
 * Triggers live in the `on:` list (a list of single-key dicts: schedule /
 * pr / comments / sentry / datadog). We round-trip the frontmatter through a
 * real YAML parser, so reads/writes preserve unrelated top-level keys and the
 * nested trigger structure stays valid.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  ChecksRule,
  DatadogRule,
  HookConfig,
  IssuesRule,
  LinearRule,
  PrRule,
  SentryRule,
} from "./hookConfig";
import { DEFAULT_CHECKS_CONCLUSIONS, DEFAULT_ISSUES_ACTIONS, parseTriggers } from "./hookConfig";

export interface Preset {
  /** Minutes between firings. */
  minutes: number;
  /** Short label rendered under the slider tick. */
  label: string;
  /** Human-readable single-line description. */
  human: string;
  /** Resulting cron string when this preset is selected. */
  cron: string;
}

/**
 * Slider stops, fastest → slowest. The slider uses log spacing so the gap
 * between 1m and 5m feels comparable to the gap between 1h and 6h.
 */
export const PRESETS: Preset[] = [
  { minutes: 1, label: "1m", human: "Every minute", cron: "* * * * *" },
  { minutes: 5, label: "5m", human: "Every 5 minutes", cron: "*/5 * * * *" },
  { minutes: 10, label: "10m", human: "Every 10 minutes", cron: "*/10 * * * *" },
  { minutes: 15, label: "15m", human: "Every 15 minutes", cron: "*/15 * * * *" },
  { minutes: 30, label: "30m", human: "Every 30 minutes", cron: "*/30 * * * *" },
  { minutes: 60, label: "1h", human: "Every hour", cron: "0 * * * *" },
  { minutes: 120, label: "2h", human: "Every 2 hours", cron: "0 */2 * * *" },
  { minutes: 360, label: "6h", human: "Every 6 hours", cron: "0 */6 * * *" },
  { minutes: 720, label: "12h", human: "Every 12 hours", cron: "0 */12 * * *" },
  { minutes: 1440, label: "daily", human: "Daily at 09:00", cron: "0 9 * * *" },
  { minutes: 10080, label: "weekly", human: "Mondays at 09:00", cron: "0 9 * * 1" },
];

/** Map a cron string back to the matching preset index, or -1 if custom. */
export function presetIndexForCron(cron: string): number {
  const normalized = cron.trim();
  return PRESETS.findIndex((p) => p.cron === normalized);
}

/**
 * Best-effort next-run prediction for a few cron shapes we actually emit:
 *   `* * * * *`           → next minute boundary
 *   `*​/N * * * *`         → next minute where (min % N === 0)
 *   `M * * * *`           → next time minute hits M
 *   `0 *​/H * * *`         → next hour where (hr % H === 0) at minute 0
 *   `M H * * *`           → next H:M (today or tomorrow)
 *   `M H * * D`           → next H:M on day-of-week D (0–6, 0=Sun)
 *
 * Returns null for shapes outside this set — caller renders "—".
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: covers six distinct cron shapes; splitting per-shape would just thread the same `from`/`base` through helpers.
export function nextRunAt(cron: string, from = new Date()): Date | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    return null;
  }
  const [min, hr, dom, mon, dow] = parts;
  if (!(min && hr && dom && mon && dow)) {
    return null;
  }

  // Only handle the simple universal cases.
  if (dom !== "*" || mon !== "*") {
    return null;
  }

  const base = new Date(from.getTime());
  base.setSeconds(0, 0);

  // Every minute: just the next minute boundary.
  if (min === "*" && hr === "*" && dow === "*") {
    base.setMinutes(base.getMinutes() + 1);
    return base;
  }

  // */N minutes at all hours: next minute where (m % N === 0).
  const minStep = parseStep(min);
  if (minStep !== null && hr === "*" && dow === "*") {
    const cursor = new Date(base.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
    const wait = (minStep - (cursor.getMinutes() % minStep)) % minStep;
    cursor.setMinutes(cursor.getMinutes() + wait);
    return cursor;
  }

  // Fixed minute "M *​": next time minute reaches M.
  if (/^\d+$/.test(min) && hr === "*" && dow === "*") {
    const target = Number(min);
    const cursor = new Date(base.getTime());
    if (cursor.getMinutes() >= target) {
      cursor.setHours(cursor.getHours() + 1);
    }
    cursor.setMinutes(target);
    return cursor;
  }

  // "0 *​/H * * *": every H hours at minute 0.
  const hrStep = parseStep(hr);
  if (hrStep !== null && /^\d+$/.test(min) && dow === "*") {
    const target = Number(min);
    const cursor = new Date(base.getTime());
    // First candidate: next hour boundary that lands on the step.
    cursor.setMinutes(target, 0, 0);
    if (cursor <= from) {
      cursor.setHours(cursor.getHours() + 1);
    }
    while (cursor.getHours() % hrStep !== 0) {
      cursor.setHours(cursor.getHours() + 1);
    }
    return cursor;
  }

  // Daily at H:M.
  if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dow === "*") {
    const targetH = Number(hr);
    const targetM = Number(min);
    const cursor = new Date(base.getTime());
    cursor.setHours(targetH, targetM, 0, 0);
    if (cursor <= from) {
      cursor.setDate(cursor.getDate() + 1);
    }
    return cursor;
  }

  // Weekly at H:M on day-of-week D.
  if (/^\d+$/.test(min) && /^\d+$/.test(hr) && /^\d+$/.test(dow)) {
    const targetH = Number(hr);
    const targetM = Number(min);
    const targetDow = Number(dow) % 7;
    const cursor = new Date(base.getTime());
    cursor.setHours(targetH, targetM, 0, 0);
    let delta = (targetDow - cursor.getDay() + 7) % 7;
    if (delta === 0 && cursor <= from) {
      delta = 7;
    }
    cursor.setDate(cursor.getDate() + delta);
    return cursor;
  }

  return null;
}

function parseStep(field: string): number | null {
  // Matches `*/N` where N is a positive integer.
  const m = /^\*\/(\d+)$/.exec(field);
  if (!m) {
    return null;
  }
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

/**
 * Human-readable countdown like "in 4m 12s" or "in 2h 13m" or "now".
 * Returns null when given null (so the caller can render "—" once).
 */
export function describeWait(target: Date | null, from = new Date()): string | null {
  if (!target) {
    return null;
  }
  const ms = target.getTime() - from.getTime();
  if (ms <= 0) {
    return "now";
  }
  const s = Math.floor(ms / 1000);
  if (s < 60) {
    return `in ${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `in ${m}m ${s % 60}s`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `in ${h}h ${m % 60}m`;
  }
  const d = Math.floor(h / 24);
  return `in ${d}d ${h % 24}h`;
}

// ---------------------------------------------------------------------------
// Frontmatter (de)serialization
// ---------------------------------------------------------------------------

/**
 * Match the `---` frontmatter block at the start of a job .md file.
 * Captures: [1] = inner block, [2] = body.
 */
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

export interface JobFrontmatter {
  /** Cron expressions from the `on:` list's `- schedule:` entries. */
  schedules: string[];
  recurring: boolean | null;
  notify: "true" | "false" | "error" | null;
  enabled: boolean | null;
  hookConfig: HookConfig | null;
}

/** Parse the top-level frontmatter mapping (or {} when absent/malformed). */
function parseFrontmatterObject(content: string): Record<string, unknown> {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return {};
  try {
    const parsed = parseYaml(m[1] ?? "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* malformed — treat as empty */
  }
  return {};
}

/**
 * Read the editor-relevant fields from a job .md file. Triggers come from the
 * `on:` list (schedules + hookConfig); recurring/notify/enabled are top-level
 * scalars. Missing values become null so the editor can show a default.
 */
export function readFrontmatter(content: string): JobFrontmatter {
  const fm = parseFrontmatterObject(content);
  const { schedules, hookConfig } = parseTriggers(content);

  const recurring = fm.recurring;
  const notify = fm.notify;
  const enabled = fm.enabled;
  return {
    schedules,
    recurring:
      recurring === undefined ? null : recurring === true || recurring === "true",
    notify:
      notify === true || notify === "true"
        ? "true"
        : notify === false || notify === "false"
          ? "false"
          : notify === "error"
            ? "error"
            : null,
    enabled: enabled === undefined ? null : enabled === true || enabled === "true",
    hookConfig,
  };
}

/**
 * Apply a patch and re-serialize the frontmatter via a YAML round-trip.
 * Unrelated top-level keys (model, effort, reuse_session, …) are preserved.
 * Triggers are rebuilt into the `on:` list from `schedules` + `hookConfig`;
 * `skip_self` is emitted as a top-level key only when explicitly disabled.
 */
export function writeFrontmatter(content: string, patch: Partial<JobFrontmatter>): string {
  const m = FRONTMATTER_RE.exec(content);
  const body = m ? (m[2] ?? "") : content;
  const fm = parseFrontmatterObject(content);

  if (patch.recurring !== undefined) {
    if (patch.recurring === null) delete fm.recurring;
    else fm.recurring = patch.recurring;
  }
  if (patch.notify !== undefined) {
    if (patch.notify === null) delete fm.notify;
    else fm.notify = patch.notify === "error" ? "error" : patch.notify === "true";
  }
  if (patch.enabled !== undefined) {
    if (patch.enabled === null) delete fm.enabled;
    else fm.enabled = patch.enabled;
  }

  if (patch.schedules !== undefined || patch.hookConfig !== undefined) {
    const current = readFrontmatter(content);
    const schedules = patch.schedules ?? current.schedules;
    const hookConfig =
      patch.hookConfig !== undefined ? patch.hookConfig : current.hookConfig;
    const on = buildOnList(schedules, hookConfig);
    if (on.length > 0) fm.on = on;
    else delete fm.on;
    if (hookConfig?.skipSelf === false) fm.skip_self = false;
    else delete fm.skip_self;
  }

  const yaml = stringifyYaml(fm).trim();
  return `---\n${yaml}\n---\n${body}`;
}

const DEFAULT_ACTIONS = ["opened", "synchronize", "reopened"];
const DEFAULT_BRANCH = ["*"];
const SHORTHAND_BRANCH = ["!main"];

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Build the `on:` list (array of single-key dicts) from schedules + a
 * HookConfig. Mirrors the parser's shorthands so round-trips stay terse:
 * a fully-open PR rule collapses to `- prs: true`, `comments`/`sentry`/
 * `datadog` collapse to `true` when unfiltered, and default rule fields are
 * omitted.
 */
function buildOnList(schedules: string[], cfg: HookConfig | null): unknown[] {
  const on: unknown[] = [];
  for (const s of schedules) {
    if (s.trim()) on.push({ schedule: s.trim() });
  }
  if (!cfg) return on;

  if (isFullyOpen(cfg.pr)) {
    on.push({ prs: true });
  } else {
    for (const r of cfg.pr) on.push({ pr: prRuleObject(r) });
  }

  if (cfg.comments === true) {
    on.push({ comments: true });
  } else if (cfg.comments && typeof cfg.comments === "object") {
    on.push({ comments: { user: cfg.comments.user } });
  }

  const sentry = sentryValue(cfg.sentry);
  if (sentry !== null) on.push({ sentry });
  const datadog = datadogValue(cfg.datadog);
  if (datadog !== null) on.push({ datadog });
  const linear = linearValue(cfg.linear);
  if (linear !== null) on.push({ linear });
  const checks = checksValue(cfg.checks);
  if (checks !== null) on.push({ checks });
  const issues = issuesValue(cfg.issues);
  if (issues !== null) on.push({ issues });

  return on;
}

function prRuleObject(r: PrRule): Record<string, unknown> {
  const o: Record<string, unknown> = { repo: r.repo, user: r.user };
  if (!sameList(r.action, DEFAULT_ACTIONS)) o.action = r.action;
  if (!sameList(r.branch, DEFAULT_BRANCH)) o.branch = r.branch;
  if (r.labels.length > 0) o.labels = r.labels;
  if (r.draft !== false) o.draft = r.draft;
  return o;
}

/** `true` (any), a filtered mapping, or null (off). */
function sentryValue(s: HookConfig["sentry"]): unknown | null {
  if (s === true) return true;
  if (!s || typeof s !== "object") return null;
  const rule: SentryRule = s;
  const o: Record<string, unknown> = {};
  // Always emit fields when present — including `["*"]`. Collapsing to a bare
  // `sentry: true` was wrong: `true` re-parses to the errors-only/prod-only
  // default, silently downgrading the user's explicit choice.
  if (rule.resource.length > 0) o.resource = rule.resource;
  if (rule.project.length > 0) o.project = rule.project;
  if (rule.environment.length > 0) o.environment = rule.environment;
  if (rule.level.length > 0) o.level = rule.level;
  if (rule.action.length > 0) o.action = rule.action;
  if (rule.host.length > 0) o.host = rule.host;
  // firstSeen / debounceMs default to false / 0 — emit only when set, so a
  // plain rule stays compact, but an explicit value round-trips exactly.
  if (rule.firstSeen) o.firstSeen = true;
  if (rule.debounceMs > 0) o.debounceMs = rule.debounceMs;
  return Object.keys(o).length > 0 ? o : true;
}

/** `true` (@mentioned Issue/Comment default), a filtered mapping, or null (off).
 *  EXACT round-trip: an omitted `type` re-parses to the [Issue, Comment] default
 *  and an omitted `priority`/`state`/`labels` re-parses to `[]`, so we emit
 *  `type` whenever it differs from the default (INCLUDING an explicit `[]` "any
 *  type" — the old `type.length > 0` guard dropped it and let the all-empty
 *  collapse silently re-narrow to the default). Only a rule that is byte-for-byte
 *  the default collapses to the bare `linear: true` shorthand. */
function linearValue(l: HookConfig["linear"]): unknown | null {
  if (l === true) return true;
  if (!l || typeof l !== "object") return null;
  const rule: LinearRule = l;
  const typeIsDefault =
    rule.type.length === 2 && rule.type.includes("Issue") && rule.type.includes("Comment");
  if (
    typeIsDefault &&
    rule.team.length === 0 &&
    rule.action.length === 0 &&
    rule.priority.length === 0 &&
    rule.state.length === 0 &&
    rule.labels.length === 0 &&
    rule.mention === true
  ) {
    return true; // bare `on: - linear` re-parses to exactly this
  }
  const o: Record<string, unknown> = {};
  if (!typeIsDefault) o.type = rule.type;
  if (rule.team.length > 0) o.team = rule.team;
  if (rule.action.length > 0) o.action = rule.action;
  if (rule.priority.length > 0) o.priority = rule.priority;
  if (rule.state.length > 0) o.state = rule.state;
  if (rule.labels.length > 0) o.labels = rule.labels;
  // mention defaults to true — only emit the explicit `false`.
  if (rule.mention === false) o.mention = false;
  return o;
}

/** `true` (bad-CI default), a filtered mapping, or null (off). EXACT round-trip:
 *  `conclusion` is emitted even when `[]` because an omitted conclusion re-parses
 *  to the bad-CI default — collapsing an explicit "any" (`[]`) to `{}`/`true`
 *  would silently re-narrow it (the old sentryValue bug). Only a rule that is
 *  byte-for-byte the default collapses to the bare `checks: true` shorthand. */
function checksValue(c: HookConfig["checks"]): unknown | null {
  if (c === true) return true;
  if (!c || typeof c !== "object") return null;
  const rule: ChecksRule = c;
  if (
    sameList(rule.conclusion, DEFAULT_CHECKS_CONCLUSIONS) &&
    rule.branch.length === 0 &&
    rule.name.length === 0
  ) {
    return true; // bare `on: - checks` re-parses to exactly this
  }
  const o: Record<string, unknown> = { conclusion: rule.conclusion };
  if (rule.branch.length > 0) o.branch = rule.branch;
  if (rule.name.length > 0) o.name = rule.name;
  return o;
}

/** `true` (opened-only default), a filtered mapping, or null (off). EXACT
 *  round-trip: `action` is emitted even when `[]` because an omitted action
 *  re-parses to `["opened"]`. Only the byte-for-byte default collapses to
 *  `issues: true`. */
function issuesValue(i: HookConfig["issues"]): unknown | null {
  if (i === true) return true;
  if (!i || typeof i !== "object") return null;
  const rule: IssuesRule = i;
  if (sameList(rule.action, DEFAULT_ISSUES_ACTIONS) && rule.label.length === 0) {
    return true;
  }
  const o: Record<string, unknown> = { action: rule.action };
  if (rule.label.length > 0) o.label = rule.label;
  return o;
}

function datadogValue(d: HookConfig["datadog"]): unknown | null {
  if (d === true) return true;
  if (!d || typeof d !== "object") return null;
  const rule: DatadogRule = d;
  const o: Record<string, unknown> = {};
  const monitorWide = rule.monitor.length === 1 && rule.monitor[0] === "*";
  if (rule.monitor.length > 0 && !monitorWide) o.monitor = rule.monitor;
  if (rule.priority.length > 0) o.priority = rule.priority;
  if (rule.type.length > 0) o.type = rule.type;
  if (rule.tags.length > 0) o.tags = rule.tags;
  return Object.keys(o).length > 0 ? o : true;
}

/** A single permissive rule (any repo, anyone, default actions, `!main`,
 *  no labels, not draft) collapses to the `- prs: true` shorthand. */
function isFullyOpen(rules: PrRule[]): boolean {
  if (rules.length !== 1) return false;
  const r = rules[0];
  if (!r) return false;
  const repoWildcard =
    (typeof r.repo === "string" && (r.repo === "*" || r.repo === "*/*")) ||
    (Array.isArray(r.repo) && r.repo.length === 1 && (r.repo[0] === "*" || r.repo[0] === "*/*"));
  return (
    repoWildcard &&
    r.user.length === 1 &&
    r.user[0] === "*" &&
    sameList(r.action, DEFAULT_ACTIONS) &&
    sameList(r.branch, SHORTHAND_BRANCH) &&
    r.labels.length === 0 &&
    r.draft === false
  );
}
