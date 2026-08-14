/**
 * Build the web bundle from source, installing dependencies first when they
 * are missing.
 *
 * The plugin ships as a git checkout (`.claude-plugin/marketplace.json` sources
 * `./`), and `dist/` + `node_modules/` are both gitignored — so a
 * `claude plugin install` cache entry
 * (`~/.claude/plugins/cache/<marketplace>/errandd/<ver>/`) carries the web
 * *sources* and nothing else. Without the install step below, `web/build.ts`
 * dies on its first line ("Tailwind CSS build failed … null" — the
 * `node_modules/.bin/tailwindcss` binary doesn't exist) and every /ui/ route
 * 404s "UI not built — run `bun run build:web`" for the life of the deploy.
 *
 * Also runnable standalone as `bun run build:web:ensure`; CI uses that on a
 * pristine checkout to prove a released tree can build its own UI with nothing
 * but `bun` on PATH.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Package root (the `errandd/` dir) — one level up from `app/`. */
export function webPackageRoot(): string {
  return join(import.meta.dir, "..");
}

/**
 * Install dependencies when the build's toolchain is absent. Returns false only
 * when an install was needed and failed — callers then skip the build rather
 * than spend a minute reproducing the same failure.
 */
async function ensureWebDeps(root: string, log: (msg: string) => void): Promise<boolean> {
  // The Tailwind CLI is the build's first hard requirement, so its presence is
  // a sharper probe than a bare node_modules/ (a partial install still fails).
  if (existsSync(join(root, "node_modules", ".bin", "tailwindcss"))) {
    return true;
  }
  log("web deps missing — running `bun install`…");
  // --frozen-lockfile first: a released tree must build exactly what it locked.
  // Falling back to a plain install keeps a lockfile drift from taking the UI
  // down entirely.
  for (const args of [["install", "--frozen-lockfile"], ["install"]]) {
    const proc = Bun.spawn(["bun", ...args], { cwd: root, stdout: "inherit", stderr: "inherit" });
    if ((await proc.exited) === 0) {
      return true;
    }
    log(`\`bun ${args.join(" ")}\` failed`);
  }
  return false;
}

/**
 * Build the bundle when `dist/web/v3/app.js` is missing or older than any file
 * under `web/`. Never throws: a failure logs and leaves the /ui/ 404 in place.
 */
export async function ensureWebBundleBuilt(
  opts: { root?: string; log?: (msg: string) => void } = {},
): Promise<void> {
  const root = opts.root ?? webPackageRoot();
  const log = opts.log ?? ((msg: string) => console.error(`[errandd] ${msg}`));
  const buildScript = join(root, "web", "build.ts");
  const builtMarker = join(root, "dist", "web", "v3", "app.js");

  // No build script in this checkout (e.g. installed as a binary) — skip
  // silently rather than fail; the server will surface its own 404.
  if (!existsSync(buildScript)) {
    return;
  }

  let needsBuild = !existsSync(builtMarker);
  if (!needsBuild) {
    needsBuild = isSourceNewer(
      join(root, "web"),
      statSync(builtMarker).mtimeMs,
      readdirSync,
      statSync,
      join,
    );
  }
  if (!needsBuild) {
    return;
  }

  if (!(await ensureWebDeps(root, log))) {
    log("web deps unavailable — /ui/ will 404 until `bun install && bun run build:web` succeeds.");
    return;
  }

  const proc = Bun.spawn(["bun", "run", buildScript], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    log(
      `Web bundle build failed (exit ${exitCode}). The Web UI may serve a 404 until you run \`bun run build:web\` manually.`,
    );
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: shallow tree walk with early-exit; splitting per-condition would obscure the short-circuit.
export function isSourceNewer(
  dir: string,
  threshold: number,
  readdirSync: (p: string) => string[],
  statSync: (p: string) => { mtimeMs: number; isDirectory: () => boolean },
  join: (...p: string[]) => string,
): boolean {
  // Skip generated output and dependency vendoring so we don't recurse into
  // node_modules or compare against the bundle we just wrote.
  const SKIP = new Set(["node_modules", "dist", "styles.gen.css"]);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of entries) {
    if (SKIP.has(name)) {
      continue;
    }
    const full = join(dir, name);
    let s: { mtimeMs: number; isDirectory: () => boolean };
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      if (isSourceNewer(full, threshold, readdirSync, statSync, join)) {
        return true;
      }
    } else if (s.mtimeMs > threshold) {
      return true;
    }
  }
  return false;
}
