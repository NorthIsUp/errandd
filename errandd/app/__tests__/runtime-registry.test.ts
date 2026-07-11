// Existence proof for the pluggable runtime registry (overhaul 1/6).
//
// Proves the OPEN registration tier end-to-end:
//   1. a daemon plugin registers a runtime factory via PluginManager, and it
//      lands in the shared registry + resolves;
//   2. a runtime registered after the first resolve is picked up once the
//      cache is invalidated (the register-before-resolve / resetRuntimeCache
//      ordering contract documented in runtime/registry.ts);
//   3. getRuntime() itself resolves a newly-registered factory (not a closed
//      union), preserving the warn+claude fallback for unknown ids.

import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getRuntime, resetRuntime } from "../runtime/select";
import {
  registerRuntime,
  unregisterRuntime,
  hasRuntime,
  registeredRuntimeIds,
  resolveRuntime,
  resetRuntimeCache,
} from "../runtime/registry";
import { ClaudeRuntime } from "../runtime/claude";
import { PiRuntime } from "../runtime/pi";
import { PluginManager } from "../plugins";
import type { McpServer } from "../mcp";
import type { Runtime } from "../runtime/types";

/** A minimal Runtime whose methods are never actually invoked here — enough to
 *  satisfy the interface and be identity-checked after resolution. */
function makeStubRuntime(id: string): Runtime {
  const mcp = {
    list: async (): Promise<McpServer[]> => [],
    add: async (): Promise<void> => {},
    remove: async (): Promise<void> => {},
  };
  return {
    id,
    executablePath: "/bin/true",
    capabilities: {
      supportsResume: false,
      reportsContextTokens: false,
      supportsPlugins: false,
      supportsMcpCli: false,
    },
    buildRunArgs: () => [],
    buildChildEnv: (base) => base,
    cleanSpawnEnv: () => ({}),
    spawn: () => {
      throw new Error("stub runtime does not spawn");
    },
    parseStream: async () => {},
    resumeArgs: () => [],
    stripResume: (args) => args,
    withOutputMode: (args) => args,
    isCorruptedSession: () => false,
    isStaleSession: () => false,
    runOneShot: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    mcp,
  };
}

/** Restore the built-in registrations + clear the memo after each test so the
 *  shared process-wide registry never leaks state into other suites. */
afterEach(() => {
  registerRuntime("claude", () => new ClaudeRuntime());
  registerRuntime("pi", () => new PiRuntime());
  resetRuntimeCache();
});

test("built-ins claude + pi are registered at module init", () => {
  expect(hasRuntime("claude")).toBe(true);
  expect(hasRuntime("pi")).toBe(true);
  const ids = registeredRuntimeIds();
  expect(ids).toContain("claude");
  expect(ids).toContain("pi");
});

test("PluginManager.registerRuntime routes a factory into the shared registry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "errandd-rt-plugin-"));
  try {
    // A daemon plugin that registers a third harness through the plugin API.
    writeFileSync(
      join(dir, "index.js"),
      `export default function (api) {
        api.registerRuntime("plugin-stub", () => ({
          id: "plugin-stub",
          executablePath: "/bin/true",
          capabilities: { supportsResume: false, reportsContextTokens: false, supportsPlugins: false, supportsMcpCli: false },
          buildRunArgs: () => [],
          buildChildEnv: (base) => base,
          cleanSpawnEnv: () => ({}),
          spawn: () => { throw new Error("stub"); },
          parseStream: async () => {},
          resumeArgs: () => [],
          stripResume: (a) => a,
          withOutputMode: (a) => a,
          isCorruptedSession: () => false,
          isStaleSession: () => false,
          runOneShot: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
          mcp: { list: async () => [], add: async () => {}, remove: async () => {} },
        }));
      }`,
    );

    const pm = new PluginManager(dir);
    await pm.loadAll({ "rt-plugin": { enabled: true, source: dir, config: {} } });

    expect(hasRuntime("plugin-stub")).toBe(true);
    // Registration invalidated the cache, so the registry resolver returns it.
    expect(resolveRuntime(() => "plugin-stub").id).toBe("plugin-stub");
  } finally {
    unregisterRuntime("plugin-stub");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordering contract: register-after-resolve needs resetRuntimeCache", () => {
  resetRuntimeCache();

  // First resolve memoizes claude as the singleton.
  const first = resolveRuntime(() => "claude");
  expect(first.id).toBe("claude");

  // Registering a new id AFTER the first resolve does not change the memo…
  registerRuntime("late-stub", () => makeStubRuntime("late-stub"));
  expect(resolveRuntime(() => "late-stub").id).toBe("claude");

  // …until the cache is explicitly invalidated (the documented escape hatch).
  resetRuntimeCache();
  expect(resolveRuntime(() => "late-stub").id).toBe("late-stub");

  unregisterRuntime("late-stub");
});

test("getRuntime() resolves a registered factory (open, not a closed union)", () => {
  // getRuntime()'s id comes from config; capture whatever it resolves to today
  // so the proof is independent of the ambient settings.
  resetRuntime();
  const configuredId = getRuntime().id;
  resetRuntime();

  // Override that id's factory with a stub and confirm getRuntime() picks it up
  // — i.e. resolution is driven by the registry, not a hard-coded branch.
  registerRuntime(configuredId, () => makeStubRuntime("existence-stub"));
  expect(getRuntime().id).toBe("existence-stub");
  // Singleton: a second call returns the same memoized instance.
  expect(getRuntime()).toBe(getRuntime());
  // (afterEach restores the built-in factories + clears the memo.)
});

test("unknown id warns and falls back to claude (byte-for-byte)", () => {
  resetRuntimeCache();
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (msg?: unknown) => {
    warnings.push(String(msg));
  };
  try {
    const rt = resolveRuntime(() => "does-not-exist");
    expect(rt.id).toBe("claude");
    expect(warnings).toContain(`[runtime] runtime "does-not-exist" is not implemented — falling back to claude`);
  } finally {
    console.warn = orig;
  }
});
