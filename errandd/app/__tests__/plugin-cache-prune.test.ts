import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prunePluginCache } from "../maintenance/pluginCache";

let root: string; // stands in for ~/.claude/plugins

const cacheDir = () => join(root, "cache");
const versionDir = (m: string, p: string, v: string) => join(cacheDir(), m, p, v);

/** Create `cache/<marketplace>/<plugin>/<version>/` with one file, at `mtime`. */
function seedVersion(marketplace: string, plugin: string, version: string, mtimeSec: number) {
  const dir = versionDir(marketplace, plugin, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: plugin, version }));
  utimesSync(dir, mtimeSec, mtimeSec);
}

/**
 * installed_plugins.json. `installPath` is deliberately spelled through a
 * DIFFERENT absolute prefix than the real dir, mirroring the daemon where the
 * CLI records `~/.claude/plugins/...` while the files live on the state volume —
 * the matcher must key on the trailing segments, not the absolute path.
 */
function seedInstalled(entries: { marketplace: string; plugin: string; version: string }[]) {
  const plugins: Record<string, unknown[]> = {};
  for (const e of entries) {
    plugins[`${e.plugin}@${e.marketplace}`] = [
      {
        scope: "user",
        installPath: `/somewhere/else/.claude/plugins/cache/${e.marketplace}/${e.plugin}/${e.version}`,
        version: e.version,
      },
    ];
  }
  writeFileSync(join(root, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plugcache-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("prunePluginCache", () => {
  test("keeps the active version + 1 newest, deletes the rest", async () => {
    // v4 is newest but v1 is ACTIVE — both survive; v2 and v3 go.
    seedVersion("mkt", "plug", "v1", 1_000);
    seedVersion("mkt", "plug", "v2", 2_000);
    seedVersion("mkt", "plug", "v3", 3_000);
    seedVersion("mkt", "plug", "v4", 4_000);
    seedInstalled([{ marketplace: "mkt", plugin: "plug", version: "v1" }]);

    const summary = await prunePluginCache(root);

    expect(existsSync(versionDir("mkt", "plug", "v1"))).toBe(true);
    expect(existsSync(versionDir("mkt", "plug", "v4"))).toBe(true);
    expect(existsSync(versionDir("mkt", "plug", "v2"))).toBe(false);
    expect(existsSync(versionDir("mkt", "plug", "v3"))).toBe(false);
    expect(summary).toContain("removed 2");
  });

  test("never prunes when installed_plugins.json is missing", async () => {
    seedVersion("mkt", "plug", "v1", 1_000);
    seedVersion("mkt", "plug", "v2", 2_000);
    seedVersion("mkt", "plug", "v3", 3_000);

    expect(await prunePluginCache(root)).toBe("");
    for (const v of ["v1", "v2", "v3"]) {
      expect(existsSync(versionDir("mkt", "plug", v))).toBe(true);
    }
  });

  test("never prunes when the manifest lists no usable installPath", async () => {
    seedVersion("mkt", "plug", "v1", 1_000);
    seedVersion("mkt", "plug", "v2", 2_000);
    seedVersion("mkt", "plug", "v3", 3_000);
    writeFileSync(join(root, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {} }));

    expect(await prunePluginCache(root)).toBe("");
    expect(existsSync(versionDir("mkt", "plug", "v1"))).toBe(true);
  });

  test("at or below the keep count it is a no-op", async () => {
    seedVersion("mkt", "plug", "keep-a", 1_000);
    seedVersion("mkt", "plug", "keep-b", 2_000);
    seedInstalled([{ marketplace: "mkt", plugin: "plug", version: "keep-a" }]);

    expect(await prunePluginCache(root)).toBe("");
    expect(existsSync(versionDir("mkt", "plug", "keep-a"))).toBe(true);
    expect(existsSync(versionDir("mkt", "plug", "keep-b"))).toBe(true);
  });

  test("prunes each plugin independently across marketplaces", async () => {
    for (const v of ["v1", "v2", "v3"]) {
      seedVersion("mkt-a", "one", v, Number(v.slice(1)) * 1_000);
      seedVersion("mkt-b", "two", v, Number(v.slice(1)) * 1_000);
    }
    seedInstalled([
      { marketplace: "mkt-a", plugin: "one", version: "v3" },
      { marketplace: "mkt-b", plugin: "two", version: "v3" },
    ]);

    await prunePluginCache(root);

    for (const [m, p] of [["mkt-a", "one"], ["mkt-b", "two"]] as const) {
      expect(existsSync(versionDir(m, p, "v3"))).toBe(true);
      expect(existsSync(versionDir(m, p, "v2"))).toBe(true);
      expect(existsSync(versionDir(m, p, "v1"))).toBe(false);
    }
  });

  test("second run is a no-op (idempotent)", async () => {
    seedVersion("mkt", "plug", "v1", 1_000);
    seedVersion("mkt", "plug", "v2", 2_000);
    seedVersion("mkt", "plug", "v3", 3_000);
    seedInstalled([{ marketplace: "mkt", plugin: "plug", version: "v3" }]);

    expect(await prunePluginCache(root)).toContain("removed 1");
    expect(await prunePluginCache(root)).toBe("");
  });

  test("an active version that is NOT the newest still survives a deep backlog", async () => {
    // Mirrors the deployed daemon: 11 versions, active one a few back.
    for (let i = 1; i <= 11; i++) {
      seedVersion("mkt", "deep", `v${i}`, i * 1_000);
    }
    seedInstalled([{ marketplace: "mkt", plugin: "deep", version: "v5" }]);

    expect(await prunePluginCache(root)).toContain("removed 9");
    expect(existsSync(versionDir("mkt", "deep", "v5"))).toBe(true);
    expect(existsSync(versionDir("mkt", "deep", "v11"))).toBe(true);
    expect(existsSync(versionDir("mkt", "deep", "v10"))).toBe(false);
  });
});
