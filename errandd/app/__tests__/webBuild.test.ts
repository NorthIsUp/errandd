/**
 * Boot-time web build (app/webBuild.ts) — no network, no real bundling.
 * The regression that matters: a plugin-cache checkout has web sources but no
 * node_modules, and the build must install deps instead of dying on the
 * missing Tailwind CLI (see webBuild.ts).
 */
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readdirSync, statSync } from "fs";

import { ensureWebBundleBuilt, isSourceNewer, webPackageRoot } from "../webBuild";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "errandd-webbuild-"));
}

test("webPackageRoot resolves to the package root that holds web/build.ts", () => {
  const root = webPackageRoot();
  expect(readdirSync(root)).toContain("package.json");
  expect(readdirSync(join(root, "web"))).toContain("build.ts");
});

test("isSourceNewer ignores dist/ and node_modules/ but sees changed sources", () => {
  const root = tmpRoot();
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "node_modules", "vendored.js"), "x");
  writeFileSync(join(root, "app.tsx"), "x");
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(root, "app.tsx"), past, past);

  expect(isSourceNewer(root, Date.now(), readdirSync, statSync, join)).toBe(false);
  expect(isSourceNewer(root, Date.now() - 120_000, readdirSync, statSync, join)).toBe(true);
});

test("ensureWebBundleBuilt is a no-op (no deps installed) when there is no build script", async () => {
  const root = tmpRoot();
  const logs: string[] = [];
  await ensureWebBundleBuilt({ root, log: (m) => logs.push(m) });
  expect(logs).toEqual([]);
  expect(readdirSync(root)).toEqual([]);
});

test("ensureWebBundleBuilt installs deps before building when node_modules is missing", async () => {
  const root = tmpRoot();
  mkdirSync(join(root, "web"), { recursive: true });
  writeFileSync(join(root, "web", "build.ts"), "");
  // No lockfile and no package.json → `bun install` fails, which is exactly the
  // signal we want: the build is skipped with a dependency error rather than
  // being attempted against a missing toolchain.
  const logs: string[] = [];
  await ensureWebBundleBuilt({ root, log: (m) => logs.push(m) });
  expect(logs[0]).toContain("bun install");
  expect(logs.at(-1)).toContain("web deps unavailable");
});
