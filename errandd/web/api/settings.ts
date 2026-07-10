import { apiJSON } from "./client";

// ---------------------------------------------------------------------------
// Types — mirrors sanitizeSettings() in src/ui/services/state.ts
//         and HeartbeatSettingsData in src/ui/services/settings.ts
// ---------------------------------------------------------------------------

export interface ExcludeWindow {
  days?: number[];
  start: string;
  end: string;
}

export interface HeartbeatSettings {
  enabled: boolean;
  interval: number;
  prompt: string;
  excludeWindows: ExcludeWindow[];
}

export interface GitIdentity {
  name: string;
  email: string;
}

export interface Settings {
  timezone: string;
  timezoneOffsetMinutes: number;
  heartbeat: HeartbeatSettings;
  security: { level: string };
  telegram: { configured: boolean; allowedUserCount: number };
  discord: { configured: boolean; allowedUserCount: number };
  web: Record<string, unknown>;
  git: GitIdentity;
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

export function getSettings(): Promise<Settings> {
  return apiJSON<Settings>("/api/settings");
}

/**
 * Shallow-merge a patch into settings.
 * The server allows: model, fallback, security, timezone, jobsRepo, jobsRepos.
 * Returns { ok: true } on success.
 */
export function updateSettings(
  patch: Record<string, unknown>,
): Promise<{ ok: true }> {
  return apiJSON<{ ok: true }>("/api/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export function getHeartbeatSettings(): Promise<{
  ok: boolean;
  heartbeat: HeartbeatSettings;
}> {
  return apiJSON<{ ok: boolean; heartbeat: HeartbeatSettings }>(
    "/api/settings/heartbeat",
  );
}

export function updateHeartbeatSettings(
  patch: Partial<HeartbeatSettings>,
): Promise<{
  ok: boolean;
  heartbeat: HeartbeatSettings;
}> {
  return apiJSON<{ ok: boolean; heartbeat: HeartbeatSettings }>(
    "/api/settings/heartbeat",
    { method: "POST", body: JSON.stringify(patch) },
  );
}
