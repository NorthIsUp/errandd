import { apiJSON } from "./client";

// ---------------------------------------------------------------------------
// Types — mirrors buildState() in src/ui/services/state.ts
// ---------------------------------------------------------------------------

export interface DaemonInfo {
  running: boolean;
  pid: number;
  startedAt: number;
  uptimeMs: number;
}

export interface HeartbeatInfo {
  enabled: boolean;
  intervalMinutes: number;
  nextAt: number | null;
  nextInMs: number | null;
}

export interface JobsRepoConfig {
  kind: "git" | "plugin";
  url: string;
  branch: string;
  intervalSeconds: number;
}

export interface RuntimeGit {
  sha?: string;
  sha8?: string;
  dirty?: boolean;
  branch?: string;
  commitUrl?: string;
  tag?: string | null;
  describe?: string | null;
}

export interface JobSummary {
  name: string;
  /** All cron schedules for this routine (empty for event-only). */
  schedules: string[];
  /** First schedule, kept for back-compat with single-cron consumers. */
  schedule: string;
  prompt: string;
  running: boolean;
  lastResult: "ok" | "error" | "skipped" | "pass" | null;
  lastRanAt: number | null;
}

export interface SecuritySettings {
  level: string;
}

export interface StateResponse {
  daemon: DaemonInfo;
  model: string;
  fallback: { model: string; api: string } | string;
  jobsRepo: JobsRepoConfig | null; // back-compat
  jobsRepos: JobsRepoConfig[];
  timezone: string;
  timezoneOffsetMinutes: number;
  heartbeat: HeartbeatInfo;
  jobs: JobSummary[];
  security: SecuritySettings;
  telegram: { configured: boolean; allowedUserCount: number };
  discord: { configured: boolean; allowedUserCount: number };
  session: {
    sessionIdShort: string;
    createdAt: string;
    lastUsedAt: string;
  } | null;
  web: Record<string, unknown>;
  git: { name: string; email: string };
  /** Populated when the request came in over a trusted Tailscale proxy
   *  (daemon launched with `--web-trust-tailnet`) and carried the
   *  `Tailscale-User-Login` header. Null in the token/cookie path. */
  tailnet: {
    login: string;
    displayName?: string;
    tailnet?: string;
  } | null;
  runtime: {
    git: RuntimeGit;
    version: string | null;
  };
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

export function getState(): Promise<StateResponse> {
  return apiJSON<StateResponse>("/api/state");
}
