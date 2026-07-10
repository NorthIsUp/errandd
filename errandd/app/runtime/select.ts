// Runtime selection.
//
// Reads `Settings.runtime` (or the ERRANDD_RUNTIME env var) once and returns a
// cached singleton. Default is "claude", which is byte-identical to the
// daemon's historical behavior. A future "pi" runtime slots in by adding its
// implementation + a branch here — no runner.ts / sessions / queue / UI change.

import { getSettings } from "../config";
import { ClaudeRuntime } from "./claude";
import { PiRuntime } from "./pi";
import type { Runtime } from "./types";

let cached: Runtime | null = null;

function resolveRuntimeId(): string {
  try {
    return (getSettings().runtime || process.env.ERRANDD_RUNTIME || "claude").toLowerCase();
  } catch {
    // Settings not loaded yet — fall back to the env var / default.
    return (process.env.ERRANDD_RUNTIME ?? "claude").toLowerCase();
  }
}

export function getRuntime(): Runtime {
  if (cached) return cached;
  const id = resolveRuntimeId();
  if (id === "pi") {
    cached = new PiRuntime();
  } else {
    if (id !== "claude") {
      console.warn(`[runtime] runtime "${id}" is not implemented — falling back to claude`);
    }
    cached = new ClaudeRuntime();
  }
  return cached;
}

/** Reset the cached runtime (tests / settings hot-reload). */
export function resetRuntime(): void {
  cached = null;
}
