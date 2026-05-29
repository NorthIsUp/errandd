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
    excludeWindows?: Array<{ days?: number[]; start: string; end: string }>;
  }) => void | Promise<void>;
  onJobsChanged?: () => void | Promise<void>;
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
  /** Config-driven skip callback (see WebhookDeps.onHookSkip). */
  onHookSkip?: (
    jobName: string,
    event: string,
    deliveryId: string,
    payload: unknown,
    reason: string,
  ) => Promise<void> | void;
  /** Register a callback that fires whenever a job starts or finishes. The
   *  callback receives the full live status snapshot. Returns an
   *  unsubscribe function. Powers the /api/jobs/events SSE stream. */
  subscribeJobStatus?: (cb: (snapshot: JobStatusSnapshot) => void) => () => void;
}

export interface JobStatusSnapshot {
  /** Names of jobs currently in flight. */
  active: string[];
  /** Most recent result per job, keyed by name. */
  results: Record<string, JobLastResult>;
}
