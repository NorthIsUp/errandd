import { apiJSON } from "./client";

// ---------------------------------------------------------------------------
// Types — mirrors src/jobsRepo.ts RepoStatus and JobsRepoPlugin
// ---------------------------------------------------------------------------

export interface JobsRepoPlugin {
  name: string;
  dir: string;
  skills: string[];
  commands: string[];
  agents: string[];
}

export interface RepoStatus {
  slug: string;
  kind: "git" | "plugin";
  url: string;
  configured: boolean;
  cloned: boolean;
  dirty: boolean;
  ahead: number;
  behind: number;
  branch: string;
  dir: string;
  lastPullAt: string | null;
  lastError: string | null;
  plugins: JobsRepoPlugin[];
  jobs: number;
}

export interface SyncResult {
  ok: boolean;
  committed: boolean;
  pushed: boolean;
  message: string;
  error: string | null;
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

export function listRepos(): Promise<RepoStatus[]> {
  return apiJSON<RepoStatus[]>("/api/jobs/repos");
}

export function pullRepo(slug: string): Promise<RepoStatus> {
  return apiJSON<RepoStatus>(
    `/api/jobs/repos/${encodeURIComponent(slug)}/pull`,
    { method: "POST" },
  );
}

export function syncRepo(slug: string): Promise<SyncResult> {
  return apiJSON<SyncResult>(
    `/api/jobs/repos/${encodeURIComponent(slug)}/sync`,
    { method: "POST" },
  );
}
