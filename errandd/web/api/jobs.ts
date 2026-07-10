import { apiJSON } from "./client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JobFileEntry {
  path: string;
  isJob: boolean;
  /** Frontmatter `description:`, shown as routine subtext. */
  description?: string;
  /** Durable on/off overlay state (default true). Only set for routines. */
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Helper — build ?repo= query param when a slug is provided
// ---------------------------------------------------------------------------

function repoParam(repoSlug?: string | null): string {
  if (!repoSlug) return "";
  return `&repo=${encodeURIComponent(repoSlug)}`;
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

export function listJobFiles(
  repoSlug?: string | null,
): Promise<JobFileEntry[]> {
  const qs = repoSlug ? `?repo=${encodeURIComponent(repoSlug)}` : "";
  return apiJSON<JobFileEntry[]>(`/api/jobs/files${qs}`);
}

export function getJobFile(
  path: string,
  repoSlug?: string | null,
): Promise<{ path: string; content: string }> {
  const qs = `?path=${encodeURIComponent(path)}${repoParam(repoSlug)}`;
  return apiJSON<{ path: string; content: string }>(`/api/jobs/file${qs}`);
}

export function writeJobFile(
  path: string,
  content: string,
  repoSlug?: string | null,
): Promise<{ ok: true }> {
  const qs = repoSlug ? `?repo=${encodeURIComponent(repoSlug)}` : "";
  return apiJSON<{ ok: true }>(`/api/jobs/file${qs}`, {
    method: "PUT",
    body: JSON.stringify({ path, content }),
  });
}

export function createJobFile(
  path: string,
  repoSlug?: string | null,
): Promise<{ ok: true }> {
  const qs = repoSlug ? `?repo=${encodeURIComponent(repoSlug)}` : "";
  return apiJSON<{ ok: true }>(`/api/jobs/file${qs}`, {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

export function deleteJobFile(
  path: string,
  repoSlug?: string | null,
): Promise<{ ok: true }> {
  const qs = `?path=${encodeURIComponent(path)}${repoParam(repoSlug)}`;
  return apiJSON<{ ok: true }>(`/api/jobs/file${qs}`, { method: "DELETE" });
}

/** Flip a routine's durable on/off overlay (persisted in errandd's state dir,
 *  NOT the .md file). */
export function toggleRoutine(
  path: string,
  enabled: boolean,
  repoSlug?: string | null,
): Promise<{ ok: true; enabled: boolean }> {
  return apiJSON<{ ok: true; enabled: boolean }>("/api/jobs/toggle", {
    method: "POST",
    body: JSON.stringify({ path, enabled, slug: repoSlug ?? undefined }),
  });
}

export function autoNameJobFile(
  path: string,
): Promise<{ ok: true; newPath: string }> {
  return apiJSON<{ ok: true; newPath: string }>("/api/jobs/file/auto-name", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}
