import { apiJSON } from "./client";

// ---------------------------------------------------------------------------
// Types — mirrors src/slashRegistry.ts SlashEntry
// ---------------------------------------------------------------------------

export interface SlashEntry {
  name: string;
  source: string;
  kind: "skill" | "command";
  description?: string;
  plugin?: string;
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

export function listSlashEntries(): Promise<SlashEntry[]> {
  return apiJSON<SlashEntry[]>("/api/slash");
}
