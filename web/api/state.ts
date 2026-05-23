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
}

export interface JobSummary {
  name: string;
  schedule: string;
  prompt: string;
}

export interface SecuritySettings {
  level: string;
}

export interface StateResponse {
  daemon: DaemonInfo;
  model: string;
  fallback: string;
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
  runtime: {
    git: RuntimeGit;
  };
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

export function getState(): Promise<StateResponse> {
  return apiJSON<StateResponse>("/api/state");
}
