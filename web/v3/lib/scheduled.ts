import type { SessionInfo } from "../../api/sessions";
import type { TreeItem, TreeSection } from "./tree";

/**
 * Build the Schedules section from scheduled JOBS + their recent run SESSIONS,
 * rather than the hook queue (cron / scheduled routine runs never enter the
 * durable hook queue, so they were structurally invisible to `buildTree`).
 *
 *   /api/jobs    → jobs; a job with a non-empty `schedules` array is a
 *                  *scheduled routine* (the subject/`TreeItem`).
 *   /api/sessions → recent runs; each session that belongs to a scheduled
 *                  routine becomes a `ThreadRef` (its chat thread).
 *
 * The Schedules `TreeSection` produced here REPLACES the (empty) queue-sourced
 * one in the sidebar; the other four sections keep their live-queue sourcing.
 */

/** Minimal shape of a `/api/jobs` row (see src/ui/routes/jobs.ts `jobsList`). */
export interface JobListEntry {
  name: string;
  schedules: string[];
  schedule: string;
  promptPreview: string;
}

/** A scheduled routine = a job that has at least one cron schedule. */
export function isScheduledJob(j: JobListEntry): boolean {
  return Array.isArray(j.schedules) && j.schedules.length > 0;
}

/** Map a `SessionInfo.result` to the sidebar's `ThreadRef` status+outcome. */
function statusForSession(s: SessionInfo): {
  status: TreeItem["routines"][number]["status"];
  outcome: TreeItem["routines"][number]["outcome"];
} {
  // `result` is set once a run finishes. A missing result usually just means an
  // older run that predates the field — only treat it as "running" if it was
  // touched very recently (a genuinely in-flight run); otherwise it's a finished
  // run of unknown outcome, shown as a neutral "done" (not a misleading spinner
  // on weeks-old runs).
  if (!s.result) {
    const recent = Date.now() - new Date(s.lastUsedAt).getTime() < 5 * 60_000;
    return recent ? { status: "running", outcome: null } : { status: "done", outcome: "pass" };
  }
  switch (s.result) {
    case "ok":
      return { status: "done", outcome: "ok" };
    case "pass":
    case "skipped":
      return { status: "done", outcome: "pass" };
    case "error":
      return { status: "failed", outcome: "error" };
    default:
      return { status: "done", outcome: "ok" };
  }
}

/**
 * Does `session` belong to scheduled routine `jobName`?
 *
 * Cron-run sessions are NOT `:hook:` threads. We match a session to a scheduled
 * routine by, in order of confidence:
 *   1. its persisted `jobName` equals the routine name, and the trigger is a
 *      schedule (or absent — legacy sessions predating the trigger field), and
 *      it is not an explicit hook/manual run;
 *   2. fallback: the session id / threadId is prefixed with `<jobName>:` but is
 *      NOT a `:hook:` thread (those belong to the other sections).
 */
function sessionMatchesJob(s: SessionInfo, jobName: string): boolean {
  const isHookThread = s.id.includes(":hook:");
  if (isHookThread) {
    return false;
  }
  if (s.jobName === jobName) {
    // Explicit hook/manual triggers belong elsewhere; schedule (or no trigger
    // recorded) stays in Schedules.
    if (s.trigger?.kind === "hook") {
      return false;
    }
    return true;
  }
  // Fallback for sessions whose jobName wasn't persisted: id prefix match.
  return s.id.startsWith(`${jobName}:`) && !isHookThread;
}

function sessionTime(s: SessionInfo): number {
  const t = new Date(s.lastUsedAt).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Build the Schedules `TreeSection` from scheduled jobs + sessions. Pure —
 * memoize on `[jobs, sessions]`. Each scheduled routine is one `TreeItem`; its
 * matched run sessions are the `ThreadRef`s (newest first). Routines with no
 * runs yet still appear (so e.g. `dependabot-merge` / `clone-clara-v1` show up
 * the moment they're scheduled, before their first run).
 */
export function buildScheduledSection(
  jobs: JobListEntry[],
  sessions: SessionInfo[],
): TreeSection {
  const scheduled = jobs.filter(isScheduledJob);
  // Index sessions by the routine they belong to (a session can only belong to
  // one routine — first scheduled job that claims it wins, by name).
  const byJob = new Map<string, SessionInfo[]>();
  for (const job of scheduled) {
    byJob.set(job.name, []);
  }
  for (const s of sessions) {
    for (const job of scheduled) {
      if (sessionMatchesJob(s, job.name)) {
        byJob.get(job.name)?.push(s);
        break;
      }
    }
  }

  const items: TreeItem[] = scheduled.map((job) => {
    const runs = (byJob.get(job.name) ?? [])
      .slice()
      .sort((a, b) => sessionTime(b) - sessionTime(a));
    const routines = runs.map((s) => {
      const { status, outcome } = statusForSession(s);
      return {
        threadId: s.id,
        // Label each run by its title or kickoff time so multiple runs are
        // distinguishable; fall back to the cron when nothing else.
        jobName: s.title && s.title.length > 0 ? s.title : runLabel(s, job),
        status,
        outcome,
        lastAt: sessionTime(s),
      };
    });
    const lastAt = routines.reduce((m, r) => Math.max(m, r.lastAt), 0);
    return {
      key: job.name,
      title: job.name,
      routines,
      lastAt,
    };
  });

  items.sort((a, b) => b.lastAt - a.lastAt);
  return { source: "routines", label: "Schedules", items };
}

/** Human label for one run thread: prefer the session title, else its start. */
function runLabel(s: SessionInfo, job: JobListEntry): string {
  const at = new Date(s.createdAt);
  if (Number.isFinite(at.getTime())) {
    const hh = String(at.getHours()).padStart(2, "0");
    const mm = String(at.getMinutes()).padStart(2, "0");
    const mon = at.toLocaleString(undefined, { month: "short", day: "numeric" });
    return `${mon} ${hh}:${mm}`;
  }
  return job.schedule.length > 0 ? job.schedule : "run";
}
