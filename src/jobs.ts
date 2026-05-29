import { readdir } from "fs/promises";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { getAgentsDir, getJobsDir } from "./config";
import { type HookConfig, parseHookConfig } from "./hooks/schema";

export interface Job {
  /** Scheduler key. For standalone jobs this is the file stem. For agent-scoped jobs this is "agent/label". */
  name: string;
  schedule: string;
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

  // A routine needs at least one trigger: a `schedule:` (cron) or an
  // `on:` block (webhook-driven). Requiring the `schedule:` *key* to be
  // present was fragile — clearJobSchedule strips it on one-shot
  // completion, and any hand-edit/save path that omits it would silently
  // drop an event-only hook routine (it leaves the live set and stops
  // matching webhooks). Treat a missing schedule as empty when an `on:`
  // block is present; only bail when there's no trigger at all.
  if (!("schedule" in fm) && !("on" in fm)) {
    return null;
  }
  const schedule = asString(fm.schedule).trim();

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

  let hookConfig: HookConfig | undefined;
  try {
    const parsed = parseHookConfig(fm.on);
    if (parsed) hookConfig = parsed;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`hook config error in ${name}: ${msg}`);
    // Don't return null — a malformed `on:` block shouldn't take down
    // the rest of the job. Hook matcher just won't see this job.
  }

  return {
    name,
    schedule,
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

  let flatFiles: string[] = [];
  try {
    flatFiles = await readdir(getJobsDir());
  } catch {
    /* missing dir is fine */
  }
  for (const file of flatFiles) {
    if (!file.endsWith(".md")) continue;
    const content = await Bun.file(join(getJobsDir(), file)).text();
    const job = parseJobFile(file.replace(/\.md$/, ""), content);
    if (!job) continue;
    if (job.enabled !== false) jobs.push(job);
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

export async function clearJobSchedule(jobName: string): Promise<void> {
  const path = resolveJobPath(jobName);
  const content = await Bun.file(path).text();
  const match = content.match(FRONTMATTER_RE);
  if (!match) return;

  const filteredFrontmatter = (match[1] ?? "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("schedule:"))
    .join("\n")
    .trim();

  const body = (match[2] ?? "").trim();
  const next = `---\n${filteredFrontmatter}\n---\n${body}\n`;
  await Bun.write(path, next);
}
