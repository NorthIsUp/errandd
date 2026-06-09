import { readdir } from "fs/promises";
import { join } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getAgentsDir, getJobsDir, getJobsDirs } from "./config";
import { type HookConfig, parseTriggers } from "./hooks/schema";

export interface Job {
  /** Scheduler key. For standalone jobs this is the file stem. For agent-scoped jobs this is "agent/label". */
  name: string;
  /** Cron expressions from the routine's `- schedule:` triggers. The job
   *  fires when ANY of them is due. Empty for event-only routines. */
  schedules: string[];
  prompt: string;
  recurring: boolean;
  notify: true | false | "error";
  /** When set, overrides the global model for this job. Useful for routing cheap tasks to haiku. */
  model?: string;
  /** When set, overrides the global session timeout for this job (in seconds). */
  timeoutSeconds?: number;
  /** If set, this job is scoped to an agent. */
  agent?: string;
  /** Human-readable label for agent-scoped jobs (file stem). */
  label?: string;
  /** When false, the job is loaded but not scheduled. Defaults to true. */
  enabled?: boolean;
  /** Max number of retry attempts on failure before giving up until next scheduled run. */
  retry?: number;
  /** Seconds to wait between retry attempts. Defaults to 300 (5 min). */
  retryDelay?: number;
  /** When true, resume the same session across all runs. Default false (fresh session per run). */
  reuseSession: boolean;
  /** Event-driven triggers parsed from the `on:` block (see hooks/schema.ts). */
  hookConfig?: HookConfig;
}

/** Thread ID for a job run. reuseSession → stable base (one resumed session);
 *  otherwise base + ":" + runId (fresh session per run). */
export function buildJobThreadId(base: string, reuseSession: boolean, runId: string): string {
  return reuseSession ? base : `${base}:${runId}`;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

function asBoolean(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "yes" || s === "1") return true;
    if (s === "false" || s === "no" || s === "0") return false;
  }
  return fallback;
}

function asString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return String(v);
}

function asPositiveInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function parseJobFile(name: string, content: string): Job | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    console.error(`Invalid job file format: ${name}`);
    return null;
  }

  const frontmatterRaw = match[1] ?? "";
  const prompt = (match[2] ?? "").trim();

  let fm: Record<string, unknown>;
  try {
    const parsed = parseYaml(frontmatterRaw);
    if (parsed === null || parsed === undefined) {
      fm = {};
    } else if (typeof parsed === "object" && !Array.isArray(parsed)) {
      fm = parsed as Record<string, unknown>;
    } else {
      console.error(`Invalid frontmatter in ${name}: expected a mapping`);
      return null;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`YAML parse error in ${name}: ${msg}`);
    return null;
  }

  // recurring (with `daily` as a legacy alias).
  const recurring = asBoolean(fm.recurring ?? fm.daily, false);

  // notify: true (default) / false / "error".
  let notify: true | false | "error" = true;
  const notifyRaw = fm.notify;
  if (notifyRaw === false || notifyRaw === "false" || notifyRaw === "no") {
    notify = false;
  } else if (notifyRaw === "error") {
    notify = "error";
  }

  const model = asString(fm.model).trim() || undefined;
  const timeoutSeconds = asPositiveInt(fm.timeout);

  const agent = asString(fm.agent).trim() || undefined;
  const label = asString(fm.label).trim() || undefined;

  // enabled: defaults to undefined (true). Only false explicitly disables.
  let enabled: boolean | undefined;
  if (fm.enabled !== undefined) {
    const e = asBoolean(fm.enabled, true);
    enabled = e ? undefined : false;
  }

  const retry = asPositiveInt(fm.retry);
  const retryDelay = asPositiveInt(fm.retry_delay);
  const reuseSession = asBoolean(fm.reuse_session, false);

  // Triggers live in the `on:` list: `- schedule:` entries become cron
  // schedules, the rest (pr/comments/sentry/datadog) become the hookConfig.
  // skip_self is a top-level modifier, not a trigger.
  let schedules: string[] = [];
  let hookConfig: HookConfig | undefined;
  try {
    const parsed = parseTriggers(fm.on, fm.skip_self);
    schedules = parsed.schedules;
    if (parsed.hookConfig) hookConfig = parsed.hookConfig;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`trigger config error in ${name}: ${msg}`);
    // Don't return null on a malformed `on:` block — keep loading the rest
    // of the job; it just won't fire until the triggers are fixed.
  }

  // A routine needs at least one trigger (a schedule or an event hook).
  if (schedules.length === 0 && !hookConfig) {
    return null;
  }

  return {
    name,
    schedules,
    prompt,
    recurring,
    notify,
    model,
    timeoutSeconds,
    agent,
    label,
    enabled,
    retry,
    retryDelay,
    reuseSession,
    hookConfig,
  };
}

export async function loadJobs(): Promise<Job[]> {
  const jobs: Job[] = [];
  // Dedupe by job name across all source dirs; first dir wins so an
  // earlier repo (or the default dir) shadows a later one with the same stem.
  const seen = new Set<string>();

  // Walk every configured jobs dir in priority order (each repo's clone dir,
  // then the default local-only dir) — mirrors migrateTriggers.ts. Reading
  // only the first dir silently drops routines from later repos.
  for (const dir of getJobsDirs()) {
    let flatFiles: string[] = [];
    try {
      flatFiles = await readdir(dir);
    } catch {
      continue; // missing dir is fine
    }
    for (const file of flatFiles) {
      if (!file.endsWith(".md")) continue;
      const name = file.replace(/\.md$/, "");
      if (seen.has(name)) continue;
      const content = await Bun.file(join(dir, file)).text();
      const job = parseJobFile(name, content);
      if (!job) continue;
      seen.add(name);
      if (job.enabled !== false) jobs.push(job);
    }
  }

  // agents/ lives at project root (outside .claude/), so agent-managed jobs are writable by Claude Code.
  let agentDirs: string[] = [];
  try {
    agentDirs = await readdir(getAgentsDir());
  } catch {
    return jobs;
  }
  for (const agentName of agentDirs) {
    const agentJobsDir = join(getAgentsDir(), agentName, "jobs");
    let jobFiles: string[] = [];
    try {
      jobFiles = await readdir(agentJobsDir);
    } catch {
      continue;
    }
    for (const file of jobFiles) {
      if (!file.endsWith(".md")) continue;
      const labelFromFile = file.replace(/\.md$/, "");
      const content = await Bun.file(join(agentJobsDir, file)).text();
      const job = parseJobFile(`${agentName}/${labelFromFile}`, content);
      if (!job) continue;
      job.agent = agentName;
      job.label = labelFromFile;
      if (job.enabled !== false) jobs.push(job);
    }
  }

  return jobs;
}

function resolveJobPath(jobName: string): string {
  const slash = jobName.indexOf("/");
  if (slash > 0 && slash < jobName.length - 1) {
    const agentName = jobName.slice(0, slash);
    const label = jobName.slice(slash + 1);
    return join(getAgentsDir(), agentName, "jobs", `${label}.md`);
  }
  return join(getJobsDir(), `${jobName}.md`);
}

/**
 * Snapshot a job file's frontmatter before execution.
 * Returns a restore function that re-applies the original frontmatter
 * if Claude overwrote or stripped it during the run.
 */
export async function snapshotJobFrontmatter(jobName: string): Promise<() => Promise<boolean>> {
  const path = resolveJobPath(jobName);
  let originalContent: string;
  try {
    originalContent = await Bun.file(path).text();
  } catch {
    return async () => false;
  }

  const originalMatch = originalContent.match(FRONTMATTER_RE);
  if (!originalMatch) return async () => false;

  const originalFrontmatter = originalMatch[1] ?? "";

  return async () => {
    let currentContent: string;
    try {
      currentContent = await Bun.file(path).text();
    } catch {
      return false;
    }

    const currentMatch = currentContent.match(FRONTMATTER_RE);

    if (!currentMatch) {
      await Bun.write(path, originalContent);
      return true;
    }

    if ((currentMatch[1] ?? "").trim() !== originalFrontmatter.trim()) {
      const restoredBody = (currentMatch[2] ?? "").trim();
      const restored = `---\n${originalFrontmatter}\n---\n${restoredBody}\n`;
      await Bun.write(path, restored);
      return true;
    }

    return false;
  };
}

/**
 * One-shot completion: remove every `- schedule:` entry from the routine's
 * `on:` list so a non-recurring scheduled job won't fire again, while
 * preserving any event-hook triggers and all other frontmatter. Uses a YAML
 * round-trip rather than line surgery because the `on:` list has nested
 * items (`- pr: { ... }`) that line-prefix filtering can't safely span.
 */
export async function clearJobSchedule(jobName: string): Promise<void> {
  const path = resolveJobPath(jobName);
  const content = await Bun.file(path).text();
  const match = content.match(FRONTMATTER_RE);
  if (!match) return;

  const fm = parseYaml(match[1] ?? "") as Record<string, unknown> | null;
  if (!fm || typeof fm !== "object") return;

  if (Array.isArray(fm.on)) {
    const remaining = fm.on.filter(
      (item) => !(item && typeof item === "object" && !Array.isArray(item) && "schedule" in item),
    );
    if (remaining.length > 0) {
      fm.on = remaining;
    } else {
      delete fm.on;
    }
  }

  const body = (match[2] ?? "").trim();
  const next = `---\n${stringifyYaml(fm).trim()}\n---\n${body}\n`;
  await Bun.write(path, next);
}
