/**
 * GIT_DIR-inheritance guard. A suite run from inside a git hook (hk runs
 * `bun test` from pre-push) inherits GIT_DIR, which overrides both `cwd` and
 * `-C` — that is how a test's `git init --bare <tmp>` once landed a bare repo
 * on top of this checkout and rewrote its `.git/config`. The source scan below
 * exists because the first fix covered one call site and missed three.
 */
import { test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

import { gitEnv } from "../gitEnv";

test("gitEnv drops every repo-pointing variable", () => {
  const saved = { ...process.env };
  process.env.GIT_CONFIG_PARAMETERS = "'core.worktree'='/tmp/decoy'";
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "core.worktree";
  process.env.GIT_CONFIG_VALUE_0 = "/tmp/decoy";
  process.env.GIT_DIR = "/tmp/decoy";
  process.env.GIT_WORK_TREE = "/tmp/decoy";
  process.env.GIT_INDEX_FILE = "/tmp/decoy/index";
  process.env.GIT_COMMON_DIR = "/tmp/decoy";
  process.env.GIT_OBJECT_DIRECTORY = "/tmp/decoy/objects";
  try {
    const env = gitEnv();
    for (const key of [
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_COMMON_DIR",
      "GIT_OBJECT_DIRECTORY",
    ]) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.PATH).toBe(process.env.PATH);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(saved)) process.env[key] = value;
  }
});

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "__tests__" || name === "node_modules") return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

test("every git shell-out in app/ passes env: gitEnv()", () => {
  const spawnGit = /(?:spawnSync|Bun\.spawn|execFileSync|execSync)\(\s*\[?\s*"git"/g;
  const offenders: string[] = [];
  for (const file of tsFiles(join(import.meta.dir, ".."))) {
    const src = readFileSync(file, "utf-8");
    for (const match of src.matchAll(spawnGit)) {
      // The options object follows the argv within a few lines; gitEnv() must
      // appear there.
      if (!src.slice(match.index, match.index + 400).includes("gitEnv()")) {
        offenders.push(`${file}:${src.slice(0, match.index).split("\n").length}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
