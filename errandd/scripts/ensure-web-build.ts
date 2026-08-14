#!/usr/bin/env bun
/**
 * `bun run build:web:ensure` — the daemon's boot-time web build, runnable by
 * hand and by CI.
 *
 * Same entry point the daemon uses (`app/webBuild.ts`), so CI running this on a
 * pristine checkout — no `bun install`, no `dist/` — proves what production
 * actually depends on: that a released tree can build its own UI with nothing
 * but `bun` on PATH. The daemon swallows build failures (a 404 UI beats a dead
 * scheduler); here they're fatal.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureWebBundleBuilt, webPackageRoot } from "../app/webBuild";

const root = webPackageRoot();
await ensureWebBundleBuilt({ root });

const required = ["v3/index.html", "v3/app.js", "v3/app.css", "v2/index.html", "v2/app.js"];
const missing = required.filter((rel) => {
  const path = join(root, "dist", "web", rel);
  return !existsSync(path) || statSync(path).size === 0;
});

if (missing.length > 0) {
  console.error(`web build incomplete — missing or empty: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`web bundle ok — ${required.join(", ")}`);
