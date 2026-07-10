import { apiJSON } from "./client";

// ---------------------------------------------------------------------------
// Types — mirrors src/ui/services/usage.ts SessionUsage
// ---------------------------------------------------------------------------

export interface SessionUsage {
  sessionId: string;
  label: string;
  channel: "discord" | "web" | "unknown";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  cacheHitPct: number;
  turnCount: number;
  lastUsedAt: string;
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

export function getUsage(): Promise<SessionUsage[]> {
  return apiJSON<SessionUsage[]>("/api/usage");
}
