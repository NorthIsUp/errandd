import { apiJSON } from "./client";
import type { RepoStatus } from "./repos";
import type { StateResponse } from "./state";

// ---------------------------------------------------------------------------
// Types — mirrors GET /api/home response
// ---------------------------------------------------------------------------

export interface HomeJob {
  name: string;
  schedule: string;
  recurring: boolean;
}

export interface LogRun {
  file: string;
  mtime: number;
  lines: string[];
}

export interface LogsData {
  daemonLog: string[];
  runs: LogRun[];
}

export interface HomeResponse {
  server: StateResponse;
  jobs: HomeJob[];
  repos: RepoStatus[];
  repo: RepoStatus | null; // back-compat alias (first repo)
  logs: LogsData;
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

export function getHome(): Promise<HomeResponse> {
  return apiJSON<HomeResponse>("/api/home");
}
