// Pluggable runtime registry.
//
// Maps a runtime id → factory, so a third harness (or a daemon plugin) can
// register a Runtime without editing core selection code. The closed union
// `RuntimeId = "claude" | "pi"` and the if-branch that used to live in
// ./select are gone: the set of valid ids is whatever is registered here.
// The built-in `claude` and `pi` runtimes register at module init (bottom).
//
// ── Ordering contract ──────────────────────────────────────────────────────
// `resolveRuntime()` memoizes the first resolved Runtime as a process-wide
// singleton (public entry: `getRuntime()` in ./select). Late registrations —
// plugins, hot-reload, tests — must therefore EITHER register BEFORE the first
// resolve, OR call `resetRuntimeCache()` afterwards to invalidate the memo so
// the next resolve re-reads the registry. `PluginManager.registerRuntime`
// (app/plugins.ts) takes the reset path automatically, so plugin registration
// order relative to the first job never matters.

import { ClaudeRuntime } from "./claude";
import { PiRuntime } from "./pi";
import type { Runtime } from "./types";

/** id → Runtime factory. Lazy: the factory runs only when that id resolves. */
export type RuntimeFactory = () => Runtime;

const registry = new Map<string, RuntimeFactory>();

let cachedRuntime: Runtime | null = null;

/** Register (or override) the factory for `id` (matched case-insensitively). */
export function registerRuntime(id: string, factory: RuntimeFactory): void {
  registry.set(id.toLowerCase(), factory);
}

/** Remove a registration. Returns whether one existed. Mainly for test cleanup. */
export function unregisterRuntime(id: string): boolean {
  return registry.delete(id.toLowerCase());
}

/** Is `id` a registered runtime? */
export function hasRuntime(id: string): boolean {
  return registry.has(id.toLowerCase());
}

/** All registered runtime ids (lowercased), in registration order. */
export function registeredRuntimeIds(): string[] {
  return Array.from(registry.keys());
}

/**
 * Resolve a runtime id to a Runtime, memoizing the first result as the process
 * singleton. `idProvider` runs only on a cache miss, so callers pay for config
 * reads lazily (matching the old select behavior exactly).
 *
 * Fallback (preserved byte-for-byte from the old closed-union select): an
 * unknown/unregistered id logs a warning and falls back to the `claude`
 * built-in — never throws, never silently defaults without the warn.
 */
export function resolveRuntime(idProvider: () => string): Runtime {
  if (cachedRuntime) return cachedRuntime;
  const id = idProvider();
  const factory = registry.get(id);
  if (factory) {
    cachedRuntime = factory();
    return cachedRuntime;
  }
  console.warn(`[runtime] runtime "${id}" is not implemented — falling back to claude`);
  cachedRuntime = claudeFallback();
  return cachedRuntime;
}

/** Invalidate the memoized singleton (tests / settings hot-reload / late
 *  plugin registration). The next `resolveRuntime` re-reads the registry. */
export function resetRuntimeCache(): void {
  cachedRuntime = null;
}

/** The `claude` built-in, honoring the never-throw fallback contract even if a
 *  caller unregistered it (unreachable in normal operation). */
function claudeFallback(): Runtime {
  const factory = registry.get("claude");
  return factory ? factory() : new ClaudeRuntime();
}

// ── Built-in registrations (module init) ───────────────────────────────────
registerRuntime("claude", () => new ClaudeRuntime());
registerRuntime("pi", () => new PiRuntime());
