// Runtime selection.
//
// Reads `Settings.runtime` (or the ERRANDD_RUNTIME env var) and resolves it
// through the pluggable registry (./registry), which memoizes a process-wide
// singleton. The set of valid ids is the registry's — not a closed union — so
// a third harness or a daemon plugin slots in by registering a factory, with
// no change here. See registry.ts for the built-ins, the byte-identical
// warn+claude fallback, and the register-before-resolve / resetRuntimeCache
// ordering contract.

import { getSettings } from "../config";
import { resetRuntimeCache, resolveRuntime } from "./registry";
import type { Runtime } from "./types";

function resolveRuntimeId(): string {
  try {
    return (getSettings().runtime || process.env.ERRANDD_RUNTIME || "claude").toLowerCase();
  } catch {
    // Settings not loaded yet — fall back to the env var / default.
    return (process.env.ERRANDD_RUNTIME ?? "claude").toLowerCase();
  }
}

/** The configured runtime, as a cached process singleton. */
export function getRuntime(): Runtime {
  return resolveRuntime(resolveRuntimeId);
}

/** Reset the cached runtime (tests / settings hot-reload / late plugin
 *  registration). Delegates to the registry's cache. */
export function resetRuntime(): void {
  resetRuntimeCache();
}
