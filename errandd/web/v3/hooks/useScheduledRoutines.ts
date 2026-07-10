import { useEffect, useMemo, useState } from "react";
import { apiJSON } from "../../api/client";
import { listSessions, type SessionInfo } from "../../api/sessions";
import { buildScheduledSection, type JobListEntry } from "../lib/scheduled";
import type { TreeSection } from "../lib/tree";

/**
 * Source the sidebar's **Schedules** section from scheduled jobs + their recent
 * run sessions, rather than the hook queue.
 *
 * Cron / scheduled routine runs never enter the durable hook queue, so they're
 * invisible to `useQueueTree`/`buildTree` — the Schedules section came up
 * structurally empty. This hook fills it: it fetches `/api/jobs` (a job with a
 * non-empty `schedules` array is a scheduled routine) and `/api/sessions`
 * (their recent runs), then builds a self-contained `TreeSection` that the
 * Sidebar splices in over the (empty) queue-sourced Schedules section. The
 * other four sections keep their live hook-queue sourcing.
 *
 * Lightweight by design: a one-shot fetch on mount plus a slow poll (jobs +
 * sessions change rarely vs. the hook queue's live SSE). The heavy tree-build
 * is pure and memoized on `[jobs, sessions]`.
 */

const POLL_MS = 30_000;

function listJobsRaw(): Promise<{ jobs: JobListEntry[] }> {
  return apiJSON<{ jobs: JobListEntry[] }>("/api/jobs");
}

export interface ScheduledRoutinesState {
  /** The fully-built Schedules section (always `source: "routines"`). */
  section: TreeSection;
  /** turnCount keyed by BOTH the session UUID and its threadId, so a sidebar
   *  ThreadRef (whose `threadId` may be either form) can join by `threadId`. */
  turnByThread: Map<string, number>;
  loading: boolean;
  error: Error | null;
}

export function useScheduledRoutines(): ScheduledRoutinesState {
  const [jobs, setJobs] = useState<JobListEntry[] | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      try {
        const [jobsRes, sessionsRes] = await Promise.all([listJobsRaw(), listSessions()]);
        if (cancelled) {
          return;
        }
        setJobs(jobsRes.jobs);
        setSessions(sessionsRes);
        setError(null);
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e : new Error(String(e)));
        }
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => void load(), POLL_MS);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  const section = useMemo(
    () => buildScheduledSection(jobs ?? [], sessions ?? []),
    [jobs, sessions],
  );

  const turnByThread = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sessions ?? []) {
      map.set(s.id, s.turnCount);
      if (s.threadId) {
        map.set(s.threadId, s.turnCount);
      }
    }
    return map;
  }, [sessions]);

  return {
    section,
    turnByThread,
    loading: (jobs === null || sessions === null) && error === null,
    error,
  };
}
