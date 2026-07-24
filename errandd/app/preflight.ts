// preflight.ts — Install Claude Code plugins on first run
// Skips any plugin that is already installed.

import { execSync, execFileSync, type ExecSyncOptions } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
  rmSync,
  renameSync,
} from "fs";
import { join, dirname } from "path";
import { homedir, tmpdir } from "os";
import { fileURLToPath } from "url";

// ── Gitops manifest — the source of truth for default plugins ───────
// errandd/plugins.json declares which marketplaces install ALL their
// plugins, and which repos are cherry-picked to a named subset.
interface CherryPick {
  repo: string;
  plugins: string[];
}
interface PluginsManifest {
  marketplaces: string[];
  cherryPick: CherryPick[];
  jobsRepos: string[];
}

function loadManifest(): PluginsManifest {
  try {
    const raw = readFileSync(fileURLToPath(new URL("../plugins.json", import.meta.url)), "utf-8");
    const m = JSON.parse(raw) as Partial<PluginsManifest>;
    return {
      marketplaces: m.marketplaces ?? [],
      cherryPick: m.cherryPick ?? [],
      jobsRepos: m.jobsRepos ?? [],
    };
  } catch {
    return { marketplaces: [], cherryPick: [], jobsRepos: [] };
  }
}

const MANIFEST = loadManifest();

// ── Default-enabled allowlist ───────────────────────────────────────
// preflight INSTALLS every plugin in the manifest, but only ENABLES this
// curated set by default. Everything else installs DISABLED. Keys are the
// exact `<plugin>@<marketplace>` form preflight computes (see
// applyDefaultEnablement) — verified against each repo's marketplace.json
// `name`: context7's marketplace is `context7-marketplace`, skillz's is
// `northisup-skillz`, caveman/ponytail use `<name>@<name>`. errandd itself
// isn't installed via preflight (it runs from a git checkout) but is listed
// for completeness / anyone who does install it as a plugin.
export const DEFAULT_ENABLED = new Set<string>([
  "errandd@errandd",
  "caveman@caveman",
  "ponytail@ponytail",
  "context7@context7-marketplace",
  "skillz@northisup-skillz",
]);

// ── Config ──────────────────────────────────────────────────────────
const PLUGINS_DIR = join(homedir(), ".claude", "plugins");
const INST_FILE = join(PLUGINS_DIR, "installed_plugins.json");
const MKTP_FILE = join(PLUGINS_DIR, "known_marketplaces.json");
const WHISPER_WARMUP_SCRIPT = fileURLToPath(new URL("./whisper-warmup.ts", import.meta.url));

interface PluginEntry {
  scope: string;
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  gitCommitSha: string;
  projectPath: string;
}

interface InstalledPlugins {
  version: number;
  plugins: Record<string, PluginEntry[]>;
}

interface MarketplacePlugin {
  name: string;
  skills?: string[];
  source?: string;
}

interface MarketplaceJson {
  name: string;
  plugins: MarketplacePlugin[];
}

// ── Helpers ─────────────────────────────────────────────────────────

function run(cmd: string, opts: ExecSyncOptions = {}): string {
  const result = execSync(cmd, { encoding: "utf-8", stdio: "pipe", ...opts });
  return (result ?? "").toString().trim();
}

// argv form — no shell, so URLs/paths containing "/$()/backtick can't inject.
function runGit(args: string[], opts: ExecSyncOptions = {}): string {
  const result = execFileSync("git", args, { encoding: "utf-8", stdio: "pipe", ...opts });
  return (result ?? "").toString().trim();
}

function readJSON<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJSON(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function copyDirSync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function detectPkgManager(): string | null {
  try { run("bun --version"); return "bun"; } catch {}
  try { run("npm --version"); return "npm"; } catch {}
  return null;
}

function extractRepo(url: string): string {
  return url.replace(/.*github\.com[:/]/, "").replace(/\.git$/, "");
}

function isCached(pluginKey: string): boolean {
  const instData = readJSON<InstalledPlugins>(INST_FILE, { version: 2, plugins: {} });
  const entries = instData.plugins[pluginKey];
  if (!entries || entries.length === 0) return false;
  return entries.some((e) => existsSync(e.installPath));
}

/** Write the default enablement for `pluginKey` — `true` if it's in the
 *  curated allowlist, `false` otherwise — but ONLY when the key is absent
 *  from `enabledPlugins`. A key that already exists is a user choice (they
 *  toggled it via the dashboard), so we leave it untouched. Idempotent:
 *  re-running preflight never clobbers a user's toggle, and defaults stay
 *  sticky across reboots. Returns whether the plugin ends up enabled. */
function applyDefaultEnablement(pluginKey: string, projectPath: string): boolean {
  const projSettings = join(projectPath, ".claude", "settings.json");
  const settings = readJSON<Record<string, unknown>>(projSettings, {});
  if (!settings.enabledPlugins) settings.enabledPlugins = {};
  const enabled = settings.enabledPlugins as Record<string, boolean>;
  if (pluginKey in enabled) {
    // Existing user choice — respect it.
    return enabled[pluginKey] === true;
  }
  const on = DEFAULT_ENABLED.has(pluginKey);
  enabled[pluginKey] = on;
  writeJSON(projSettings, settings);
  return on;
}

function installDepsIfPresent(dir: string, pkgMgr: string, label: string): void {
  if (!existsSync(join(dir, "package.json"))) return;
  console.log(`    deps (${label}): ${pkgMgr} install`);
  run(`${pkgMgr} install`, { cwd: dir, stdio: "inherit" });
}

function startWhisperWarmupInBackground(): void {
  try {
    const proc = Bun.spawn([process.execPath, "run", WHISPER_WARMUP_SCRIPT], {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    proc.unref();
    console.log("preflight: whisper warmup started in background");
  } catch (err) {
    console.error(`preflight: failed to start whisper warmup - ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Install plugins from a marketplace repo ─────────────────────────
// Clones the repo once, then installs either ALL plugins it declares
// (pluginNames omitted) or a named subset (skipping names not found).
// Idempotent: cached plugins are skipped; cached-but-disabled are enabled
// for the project without re-cloning.
function installMarketplacePlugins(
  repoUrl: string,
  projectPath: string,
  pkgMgr: string,
  pluginNames?: string[],
): { installed: number; skipped: number } {
  let installed = 0;
  let skipped = 0;
  let tempDir: string | null = null;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "claude-plugin-"));
    runGit(["clone", "--quiet", "--depth", "1", repoUrl, tempDir]);

    const marketplaceJsonPath = join(tempDir, ".claude-plugin", "marketplace.json");
    if (!existsSync(marketplaceJsonPath)) {
      console.log(`  skip: ${repoUrl} (no .claude-plugin/marketplace.json)`);
      return { installed, skipped };
    }

    const marketplace = JSON.parse(readFileSync(marketplaceJsonPath, "utf-8")) as MarketplaceJson;
    const marketplaceName = marketplace.name;
    const repo = extractRepo(repoUrl);

    // Resolve targets: a named subset, or every plugin the repo declares.
    let targets: MarketplacePlugin[];
    if (pluginNames) {
      targets = [];
      for (const name of pluginNames) {
        const def = marketplace.plugins.find((p) => p.name === name);
        if (def) {
          targets.push(def);
        } else {
          console.log(`  skip: ${name} (not found in ${marketplaceName})`);
          skipped++;
        }
      }
    } else {
      targets = marketplace.plugins;
    }

    // Partition: already-installed / needs-install. Cached plugins just get
    // their default enablement applied (writes only if the key is absent, so
    // a user's dashboard toggle is never clobbered).
    const needed: MarketplacePlugin[] = [];
    for (const def of targets) {
      const pluginKey = `${def.name}@${marketplaceName}`;
      if (isCached(pluginKey)) {
        applyDefaultEnablement(pluginKey, projectPath);
        console.log(`  skip: ${pluginKey} (already installed)`);
        skipped++;
      } else {
        needed.push(def);
      }
    }

    // Nothing to fetch — leave the marketplace clone/registration untouched.
    if (needed.length === 0) return { installed, skipped };

    console.log(`  ${marketplaceName}: installing ${needed.length} plugin(s)`);

    // Persist the clone and register the marketplace once.
    const marketplaceDir = join(PLUGINS_DIR, "marketplaces", marketplaceName);
    if (existsSync(marketplaceDir)) {
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
    renameSync(tempDir, marketplaceDir);
    tempDir = null;

    const fullSha = runGit(["rev-parse", "HEAD"], { cwd: marketplaceDir });
    const shortSha = fullSha.slice(0, 12);
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");

    const mktpData = readJSON<Record<string, unknown>>(MKTP_FILE, {});
    mktpData[marketplaceName] = {
      source: { source: "github", repo },
      installLocation: marketplaceDir,
      lastUpdated: now,
    };
    writeJSON(MKTP_FILE, mktpData);

    for (const def of needed) {
      const pluginKey = `${def.name}@${marketplaceName}`;
      console.log(`  install: ${pluginKey}`);

      // Cache the plugin's source subdir (or the whole repo for single-plugin repos).
      const sourceDir = def.source ? join(marketplaceDir, def.source) : marketplaceDir;
      const cacheDir = join(PLUGINS_DIR, "cache", marketplaceName, def.name, shortSha);
      if (existsSync(cacheDir)) {
        rmSync(cacheDir, { recursive: true, force: true });
      }
      copyDirSync(sourceDir, cacheDir);

      // Ensure the marketplace.json rides along in the cache (Claude Code needs it).
      const cacheDotPlugin = join(cacheDir, ".claude-plugin");
      mkdirSync(cacheDotPlugin, { recursive: true });
      copyFileSync(
        join(marketplaceDir, ".claude-plugin", "marketplace.json"),
        join(cacheDotPlugin, "marketplace.json"),
      );

      installDepsIfPresent(cacheDir, pkgMgr, "root");
      const skillPath = def.skills?.[0];
      if (skillPath) {
        installDepsIfPresent(join(cacheDir, skillPath), pkgMgr, "skill");
      }

      const instData = readJSON<InstalledPlugins>(INST_FILE, { version: 2, plugins: {} });
      instData.plugins[pluginKey] = [
        {
          scope: "project",
          installPath: cacheDir,
          version: shortSha,
          installedAt: now,
          lastUpdated: now,
          gitCommitSha: fullSha,
          projectPath: projectPath,
        },
      ];
      writeJSON(INST_FILE, instData);

      const on = applyDefaultEnablement(pluginKey, projectPath);
      console.log(`    ${on ? "enabled" : "installed disabled"}: ${pluginKey}`);
      installed++;
    }
  } catch (err: unknown) {
    console.error(`  error: ${repoUrl} — ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  return { installed, skipped };
}

// ── Main ────────────────────────────────────────────────────────────

export function preflight(projectPath: string): void {
  try { run("git --version"); } catch {
    console.error("preflight: git is required but not installed.");
    process.exit(1);
  }

  const pkgMgr = detectPkgManager();
  if (!pkgMgr) {
    console.error("preflight: bun or npm is required.");
    process.exit(1);
  }

  mkdirSync(join(PLUGINS_DIR, "marketplaces"), { recursive: true });
  mkdirSync(join(PLUGINS_DIR, "cache"), { recursive: true });
  startWhisperWarmupInBackground();

  let installed = 0;
  let skipped = 0;

  // Marketplaces: install every plugin each repo declares.
  for (const repoUrl of MANIFEST.marketplaces) {
    const r = installMarketplacePlugins(repoUrl, projectPath, pkgMgr);
    installed += r.installed;
    skipped += r.skipped;
  }

  // Cherry-pick: install only the named subset from each repo.
  for (const entry of MANIFEST.cherryPick) {
    const r = installMarketplacePlugins(entry.repo, projectPath, pkgMgr, entry.plugins);
    installed += r.installed;
    skipped += r.skipped;
  }

  console.log(`preflight: ${installed} installed, ${skipped} skipped`);
}

// Allow standalone: bun run src/preflight.ts [project-path]
if (import.meta.main) {
  preflight(process.argv[2] || process.cwd());
}
