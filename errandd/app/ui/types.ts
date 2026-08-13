import type { Settings } from "../config";
import type { Job } from "../jobs";

export type { AgentStreamEvent } from "../runner";

export interface JobLastResult {
  result: "ok" | "error" | "skipped" | "pass";
  ranAt: number;
}

export interface WebSnapshot {
  pid: number;
  startedAt: number;
  heartbeatNextAt: number;
  settings: Settings;
  jobs: Job[];
  /** Names of jobs currently in flight (between runJob entry and completion). */
  activeJobs?: string[];
  /** Most recent outcome per job, keyed by name. */
  jobLastResult?: Record<string, JobLastResult>;
}

export interface WebServerHandle {
  stop: () => void;
  host: string;
  port: number;
}

export interface StartWebUiOptions {
  host: string;
  port: number;
  token: string;
  /**
   * If true, requests carrying a non-empty `Tailscale-User-Login` header
   * are treated as authenticated and bypass the token/cookie gate. Intended
   * for deployments behind the Tailscale operator's Ingress proxy, which
   * sets that header for tailnet-originated requests and omits it for
   * funnel (public-internet) traffic. Defaults to false.
   */
  trustTailnet?: boolean;
  getSnapshot: () => WebSnapshot;
  onHeartbeatEnabledChanged?: (enabled: boolean) => void | Promise<void>;
  onHeartbeatSettingsChanged?: (patch: {
    enabled?: boolean;
    interval?: number;
    prompt?: string;
    excludeWindows?: { days?: number[]; start: string; end: string }[];
  }) => void | Promise<void>;
  onJobsChanged?: () => void | Promise<void>;
  /** Fire a loaded routine immediately, outside its cron schedule — the same
   *  path a cron tick takes (guard, filter, session, notify), so an on-demand
   *  run is indistinguishable from a scheduled one. `skipGuard` bypasses the
   *  `guard:` pre-check, which is the point when the guard itself is the thing
   *  under suspicion. Resolves once the run is STARTED, not finished. */
  onRunJobNow?: (
    jobName: string,
    opts?: { skipGuard?: boolean },
  ) => Promise<RunJobNowResult>;
  onChat?: (
    message: string,
    onChunk: (text: string) => void,
    onUnblock: () => void,
    onAgentEvent: (ev: import("../runner").AgentStreamEvent) => void,
    opts?: { modelOverride?: string; effortOverride?: string },
  ) => Promise<void>;
  /** Invoked when a GitHub webhook matches a job's `on:` config.
   *  Called once per match; the receiver does the matching itself. */
  onHookFire?: (
    jobName: string,
    event: string,
    deliveryId: string,
    payload: unknown,
  ) => Promise<void> | void;
  /** Config-driven skip callback (see WebhookDeps.onHookSkip). `prefilter` is
   *  true for bot-noise / non-actionable drops that never reach the model. */
  onHookSkip?: (
    jobName: string,
    event: string,
    deliveryId: string,
    payload: unknown,
    reason: string,
    prefilter?: boolean,
  ) => Promise<void> | void;
  /** Returns whether a session thread already exists for `threadId` (see
   *  WebhookDeps.hasActiveThread) — powers a `checks` rule's requireActiveThread. */
  hasActiveThread?: (threadId: string) => boolean | Promise<boolean>;
  /** Register a callback that fires whenever a job starts or finishes. The
   *  callback receives the full live status snapshot. Returns an
   *  unsubscribe function. Powers the /api/jobs/events SSE stream. */
  subscribeJobStatus?: (cb: (snapshot: JobStatusSnapshot) => void) => () => void;
}

/** Outcome of an on-demand fire. `started: false` with no `error` means the
 *  routine's guard reported no work — the same silent skip a cron tick takes. */
export interface RunJobNowResult {
  ok: boolean;
  started: boolean;
  /** Why the run didn't start: "not-loaded" | "guard-no-work". */
  reason?: string;
  /** Whether the `guard:` pre-check ran, and what it decided. */
  guard?: "none" | "bypassed" | "work" | "no-work";
}

export interface JobStatusSnapshot {
  /** Names of jobs currently in flight. */
  active: string[];
  /** Most recent result per job, keyed by name. */
  results: Record<string, JobLastResult>;
}
