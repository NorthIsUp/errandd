import { readFile, writeFile } from "fs/promises";
import { SETTINGS_FILE } from "../constants";

export async function setHeartbeatEnabled(enabled: boolean): Promise<void> {
  await updateHeartbeatSettings({ enabled });
}

export interface HeartbeatSettingsPatch {
  enabled?: boolean;
  interval?: number;
  prompt?: string;
  excludeWindows?: { days?: number[]; start: string; end: string }[];
}

export interface HeartbeatSettingsData {
  enabled: boolean;
  interval: number;
  prompt: string;
  excludeWindows: { days?: number[]; start: string; end: string }[];
}

export async function readHeartbeatSettings(): Promise<HeartbeatSettingsData> {
  const raw = await readFile(SETTINGS_FILE, "utf-8");
  const data = JSON.parse(raw) as Record<string, unknown>;
  const hb: Record<string, unknown> =
    data.heartbeat !== null && typeof data.heartbeat === "object"
      ? (data.heartbeat as Record<string, unknown>)
      : {};
  return {
    enabled: Boolean(hb.enabled),
    interval: Number(hb.interval) || 15,
    prompt: typeof hb.prompt === "string" ? hb.prompt : "",
    excludeWindows: Array.isArray(hb.excludeWindows) ? (hb.excludeWindows as HeartbeatSettingsData["excludeWindows"]) : [],
  };
}

export async function updateHeartbeatSettings(patch: HeartbeatSettingsPatch): Promise<HeartbeatSettingsData> {
  const raw = await readFile(SETTINGS_FILE, "utf-8");
  const data = JSON.parse(raw) as Record<string, unknown>;
  const hb: Record<string, unknown> =
    data.heartbeat !== null && typeof data.heartbeat === "object"
      ? (data.heartbeat as Record<string, unknown>)
      : {};
  data.heartbeat = hb;

  if (typeof patch.enabled === "boolean") {
    hb.enabled = patch.enabled;
  }
  if (typeof patch.interval === "number" && Number.isFinite(patch.interval)) {
    const clamped = Math.max(1, Math.min(1440, Math.round(patch.interval)));
    hb.interval = clamped;
  }
  if (typeof patch.prompt === "string") {
    hb.prompt = patch.prompt;
  }
  if (Array.isArray(patch.excludeWindows)) {
    hb.excludeWindows = patch.excludeWindows;
  }

  await writeFile(SETTINGS_FILE, JSON.stringify(data, null, 2) + "\n");
  return {
    enabled: Boolean(hb.enabled),
    interval: Number(hb.interval) || 15,
    prompt: typeof hb.prompt === "string" ? hb.prompt : "",
    excludeWindows: Array.isArray(hb.excludeWindows) ? (hb.excludeWindows as HeartbeatSettingsData["excludeWindows"]) : [],
  };
}
