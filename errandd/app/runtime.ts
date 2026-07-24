/**
 * Runtime environment helpers — git SHA, dirty flag, and GitHub repo URL
 * for the running daemon's working directory.
 *
 * Results are cached in-process for 30 s to avoid hitting git per request.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

export interface RuntimeGit {
  sha8: string | null;
  dirty: boolean;
  commitUrl: string | null;
  repoUrl: string | null;
  tag: string | null;
  describe: string | null;
}

let _gitCache: RuntimeGit | null = null;
let _gitCacheAt = 0;
const GIT_TTL_MS = 30_000;

function git(cwd: string, args: string[]): string | null {
  try {
    const r = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (r.status !== 0 || r.error) {
      return null;
    }
    return r.stdout.trim();
  } catch {
    return null;
  }
}

function parseGitHubRepoUrl(remote: string): string | null {
  if (!remote) {
    return null;
  }
  // https://github.com/owner/repo(.git)?
  const https = /^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/.*)?$/.exec(remote);
  if (https) {
    return `https://github.com/${https[1]}`;
  }
  // git@github.com:owner/repo(.git)?
  const ssh = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  if (ssh) {
    return `https://github.com/${ssh[1]}`;
  }
  // ssh://git@github.com/owner/repo(.git)?
  const sshUrl = /^ssh:\/\/git@github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/.*)?$/.exec(remote);
  if (sshUrl) {
    return `https://github.com/${sshUrl[1]}`;
  }
  return null;
}

/** Result of comparing the running daemon's HEAD against origin's primary branch. */
export interface UpdateCheck {
  /** Deployment kind. `git` = source clone, `plugin` = Claude Code plugin
   *  install, `image` = baked-in binary / Docker image. Drives which update
   *  affordance the UI surfaces. */
  kind: "git" | "plugin" | "image";
  /** SHA (git) or version (plugin/image) the daemon is running. */
  currentSha: string | null;
  /** Latest SHA / version known from upstream. */
  latestSha: string | null;
  /** Commits / versions behind. 0 = up to date. */
  behind: number;
  /** Branch name we compared against (git only — empty for plugin/image). */
  branch: string;
  /** True if the daemon can perform `git pull --ff-only` itself. */
  canPull: boolean;
  /** True if the daemon can run `claude plugin update <name>` itself. */
  canPlugin: boolean;
  /** Command to run as the update — surfaced verbatim for the user. */
  updateCommand: string | null;
  /** GitHub compare URL between current and latest, when both are known. */
  compareUrl: string | null;
  /** Set when fetch / rev-list errored — UI can show it in a tooltip. */
  error: string | null;
}

/**
 * Fetch origin and report how far behind the running checkout is. Cached
 * for 60 s so the UI's polling doesn't hammer the network. Set
 * `force=true` to bypass.
 */
let _updateCache: UpdateCheck | null = null;
let _updateCacheAt = 0;
const UPDATE_TTL_MS = 60_000;

// biome-ignore lint/suspicious/useAwait: keeping signature async so future fetch additions don't break callers.
export async function checkForUpdate(force = false): Promise<UpdateCheck> {
  const now = Date.now();
  if (!force && _updateCache && now - _updateCacheAt < UPDATE_TTL_MS) {
    return _updateCache;
  }

  const cwd = process.cwd();
  const headRef = git(cwd, ["symbolic-ref", "--short", "HEAD"]);
  const branch = headRef || "master";
  const currentSha = git(cwd, ["rev-parse", "HEAD"]);

  // No .git in the working tree → either a Claude plugin install or a
  // baked-in image. Try the plugin update path first since it can refresh
  // in-place; fall back to "redeploy the image" otherwise.
  if (currentSha === null) {
    const pluginCheck = await checkPluginUpdate();
    if (pluginCheck) {
      _updateCache = pluginCheck;
      _updateCacheAt = now;
      return pluginCheck;
    }
    const out: UpdateCheck = {
      kind: "image",
      currentSha: getRuntimeVersion(),
      latestSha: null,
      behind: 0,
      branch: "",
      canPull: false,
      canPlugin: false,
      updateCommand: null,
      compareUrl: null,
      // `error` is reserved for real failures (fetch, auth). The "image"
      // kind by itself is a steady state, not an error — the UI renders
      // a calmer hint based on `kind === "image"` instead of an alert.
      error: null,
    };
    _updateCache = out;
    _updateCacheAt = now;
    return out;
  }

  // Fetch quietly; failure shouldn't break the rest of the response.
  const fetched = git(cwd, ["fetch", "--quiet", "origin", branch]);
  const fetchError = fetched === null ? "git fetch failed (auth/network?)" : null;

  const latestSha = git(cwd, ["rev-parse", `origin/${branch}`]);
  let behind = 0;
  if (latestSha && latestSha !== currentSha) {
    const count = git(cwd, ["rev-list", "--count", `HEAD..origin/${branch}`]);
    behind = count ? Number.parseInt(count, 10) || 0 : 0;
  }

  const remoteUrl = git(cwd, ["remote", "get-url", "origin"]);
  const repoUrl = remoteUrl ? parseGitHubRepoUrl(remoteUrl) : null;
  const compareUrl =
    repoUrl && currentSha && latestSha && currentSha !== latestSha
      ? `${repoUrl}/compare/${currentSha.slice(0, 8)}...${latestSha.slice(0, 8)}`
      : null;

  const out: UpdateCheck = {
    kind: "git",
    currentSha,
    latestSha,
    behind,
    branch,
    canPull: true,
    canPlugin: false,
    updateCommand: "git pull --ff-only",
    compareUrl,
    error: fetchError,
  };
  _updateCache = out;
  _updateCacheAt = now;
  return out;
}

/** Identity of a Claude-plugin install derived from the daemon's cwd. */
interface PluginInstallInfo {
  /** Plugin name from `.claude-plugin/plugin.json` (or path fallback). */
  plugin: string;
  /** Marketplace slug as known to the local `claude` CLI. */
  marketplace: string;
  /** GitHub `owner/repo` of the marketplace, when resolvable from
   *  `~/.claude/plugins/known_marketplaces.json`. */
  marketplaceRepo: string | null;
}

/**
 * Parse the running daemon's cwd to figure out the marketplace + plugin
 * names if this is a Claude-plugin install. Two layouts are supported:
 *
 *   ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/...
 *   ~/.claude/plugins/marketplaces/<marketplace>/<plugin>/...
 *
 * The marketplace's source repo is looked up in
 * `~/.claude/plugins/known_marketplaces.json` so we can hit the right
 * GitHub raw URL for upstream version checks.
 */
/**
 * Detect a Claude-plugin install from the daemon's candidate roots — the
 * RUNNING CODE location (from import.meta) first, then cwd. Keying off the
 * running code is what matters: in prod the daemon is launched with cwd=$HOME
 * while its code lives under ~/.claude/plugins/cache/<mkt>/<plugin>/<ver>/, so
 * a cwd-only check misreported an updatable plugin as a read-only "image".
 */
function detectPluginInstall(): PluginInstallInfo | null {
  for (const root of candidatePluginRoots()) {
    const info = parsePluginInstall(root);
    if (info) return info;
  }
  return null;
}

function parsePluginInstall(path: string): PluginInstallInfo | null {
  const marker = `${sep}.claude${sep}plugins${sep}`;
  const idx = path.indexOf(marker);
  if (idx < 0) {
    return null;
  }
  const claudeRoot = path.slice(0, idx + `${sep}.claude${sep}plugins`.length);
  const tail = path.slice(idx + marker.length).split(sep);
  // Expect [cache|marketplaces, <marketplace>, <plugin>, ...]
  if (tail.length < 3) {
    return null;
  }
  if (tail[0] !== "cache" && tail[0] !== "marketplaces") {
    return null;
  }
  const marketplace = tail[1];
  // Prefer the plugin name from plugin.json; fall back to the directory.
  const pluginFromManifest = readPluginName();
  const plugin = pluginFromManifest ?? tail[2];

  let marketplaceRepo: string | null = null;
  try {
    const raw = readFileSync(join(claudeRoot, "known_marketplaces.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, { source?: { source?: string; repo?: string; url?: string } }>;
    const entry = parsed[marketplace];
    if (entry?.source) {
      if (entry.source.source === "github" && typeof entry.source.repo === "string") {
        marketplaceRepo = entry.source.repo;
      } else if (typeof entry.source.url === "string") {
        marketplaceRepo = parseOwnerRepo(entry.source.url);
      }
    }
  } catch {
    // No known_marketplaces.json (or unreadable) — we can still offer the
    // `claude plugin update` action; just no upstream version check.
  }

  return { plugin, marketplace, marketplaceRepo };
}

/** Best-effort `owner/repo` extraction from a git/HTTPS GitHub URL. */
function parseOwnerRepo(url: string): string | null {
  const https = /^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/.*)?$/.exec(url);
  if (https) return https[1];
  const ssh = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (ssh) return ssh[1];
  const sshUrl = /^ssh:\/\/git@github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/.*)?$/.exec(url);
  if (sshUrl) return sshUrl[1];
  return null;
}

function readPluginName(): string | null {
  try {
    const raw = readFileSync(join(process.cwd(), ".claude-plugin", "plugin.json"), "utf-8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : null;
  } catch {
    return null;
  }
}

/** Build the `claude plugin update <plugin>@<marketplace>` command used as
 *  the user-facing update action. */
function pluginUpdateCommand(info: PluginInstallInfo): string {
  return `claude plugin update ${info.plugin}@${info.marketplace}`;
}

/**
 * When the daemon is running as a Claude Code plugin install, parse the
 * cwd to figure out which marketplace/plugin we are, fetch upstream
 * `marketplace.json`, and compare against the locally installed version
 * so we can offer `claude plugin update <plugin>@<marketplace>`.
 *
 * Returns null only when this clearly isn't a plugin install (cwd doesn't
 * live under `.claude/plugins/`). For plugin installs we always return a
 * usable `UpdateCheck` — even if the upstream fetch fails — so the UI
 * can render the plugin path instead of the "image" dead-end.
 */
async function checkPluginUpdate(): Promise<UpdateCheck | null> {
  const info = detectPluginInstall();
  if (!info) {
    return null;
  }
  const local = getRuntimeVersion();
  const updateCommand = pluginUpdateCommand(info);

  // No marketplace repo known → still a plugin install; just can't
  // compare versions. Surface "up to date" so the UI doesn't yell.
  if (!info.marketplaceRepo) {
    return {
      kind: "plugin",
      currentSha: local,
      latestSha: null,
      behind: 0,
      branch: "",
      canPull: false,
      canPlugin: true,
      updateCommand,
      compareUrl: null,
      error: null,
    };
  }

  let latest: string | null = null;
  let fetchError: string | null = null;
  try {
    // Try a couple of default branches — GitHub raw URLs are
    // branch-specific. `main` first, then `master`.
    const branches = ["main", "master"];
    for (const branch of branches) {
      const url = `https://raw.githubusercontent.com/${info.marketplaceRepo}/${branch}/.claude-plugin/marketplace.json`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!resp.ok) {
        fetchError = `marketplace fetch failed: HTTP ${resp.status}`;
        continue;
      }
      const body = (await resp.json()) as {
        version?: unknown;
        plugins?: { name?: unknown; version?: unknown }[];
      };
      // Prefer the version on the matching plugin entry; fall back to
      // top-level `version` for single-plugin marketplaces.
      const entry = Array.isArray(body.plugins)
        ? body.plugins.find((p) => typeof p?.name === "string" && p.name === info.plugin)
        : undefined;
      if (entry && typeof entry.version === "string") {
        latest = entry.version;
      } else if (typeof body.version === "string") {
        latest = body.version;
      }
      fetchError = null;
      break;
    }
  } catch (e) {
    fetchError = `marketplace fetch failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  // Public `behind` stays a number for back-compat (UpdateCheck.behind /
  // jobsRepo mirror it); map the boolean to 0/1.
  const behind = local && latest && latest !== local && isVersionBehind(local, latest) ? 1 : 0;
  return {
    kind: "plugin",
    currentSha: local,
    latestSha: latest,
    behind,
    branch: "",
    canPull: false,
    canPlugin: true,
    updateCommand,
    compareUrl: null,
    error: fetchError,
  };
}


/** True when `local` is an older version than `latest`, else false.
 *  Simple semver-ish compare: split on `.`, compare numerically component by
 *  component; the first differing component decides.
 *
 *  Note: the old form returned a "behind count" derived from the numeric
 *  delta of the first differing component (e.g. 1.2 → 1.5 returned 3), which
 *  was meaningless as a commit/release distance. `UpdateCheck.behind` only
 *  needs to express "is there an update?" for the plugin path, so we collapse
 *  to a boolean and map it to 0/1 at the call site to keep `behind: number`. */
function isVersionBehind(local: string, latest: string): boolean {
  const a = local.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const b = latest.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}

/** Result of `git pull --ff-only`. */
export interface UpdateResult {
  ok: boolean;
  newSha: string | null;
  output: string;
  error: string | null;
}

/**
 * Apply whatever update mechanism matches the current deployment:
 *   - git checkout → `git pull --ff-only`
 *   - claude plugin install → `claude plugin update errandd`
 *   - baked image → refused with an instructive error
 *
 * The daemon needs a manual restart after either form succeeds — the
 * running process can't cleanly swap its own code.
 */
export async function applyUpdate(): Promise<UpdateResult> {
  const cwd = process.cwd();
  const currentSha = git(cwd, ["rev-parse", "HEAD"]);

  // Plugin path — no .git, but `claude` is in PATH.
  if (currentSha === null) {
    return applyPluginUpdate();
  }

  // Reject on dirty trees — pull --ff-only would fail anyway, and we'd
  // rather surface that explicitly than leave the user wondering.
  const status = git(cwd, ["status", "--porcelain"]);
  if (status !== null && status.length > 0) {
    return {
      ok: false,
      newSha: null,
      output: "",
      error: "working tree has uncommitted changes — commit or stash before updating",
    };
  }
  const r = spawnSync("git", ["-C", cwd, "pull", "--ff-only"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  // Bust the update-check cache so the next poll reflects the new SHA.
  _updateCache = null;
  if (r.status !== 0 || r.error) {
    return {
      ok: false,
      newSha: null,
      output: (r.stdout ?? "") + (r.stderr ?? ""),
      error: r.error?.message ?? `git pull failed (exit ${r.status ?? "?"})`,
    };
  }
  const newSha = git(cwd, ["rev-parse", "HEAD"]);
  return { ok: true, newSha, output: r.stdout, error: null };
}

// biome-ignore lint/suspicious/useAwait: signature kept async for symmetry / future shell-out streaming.
async function applyPluginUpdate(): Promise<UpdateResult> {
  const info = detectPluginInstall();
  if (!info) {
    return {
      ok: false,
      newSha: null,
      output: "",
      error:
        "not a git checkout and not a Claude plugin install — redeploy the image to update",
    };
  }
  const target = `${info.plugin}@${info.marketplace}`;
  const r = spawnSync("claude", ["plugin", "update", target], {
    encoding: "utf8",
    timeout: 120_000,
  });
  _updateCache = null;
  _versionCache = null; // re-read plugin.json after update
  if (r.status !== 0 || r.error) {
    return {
      ok: false,
      newSha: null,
      output: (r.stdout ?? "") + (r.stderr ?? ""),
      error:
        r.error?.message ??
        `claude plugin update failed (exit ${r.status ?? "?"}) — is the claude CLI in PATH?`,
    };
  }
  return { ok: true, newSha: getRuntimeVersion(), output: r.stdout, error: null };
}

/** Read the plugin version from `.claude-plugin/plugin.json`. Resolved once
 *  per process — the file is bundled with the deploy and doesn't change at
 *  runtime, so a single read on first access is sufficient.
 *
 *  We can't use `process.cwd()` to find the package root: when the daemon
 *  runs from a `claude plugin install` cache entry
 *  (`~/.claude/plugins/cache/<marketplace>/<plugin>/<ver>/`) cwd is the
 *  user's HOME, not the plugin dir, and the manifest lookup misses.
 *  `import.meta.url` resolves to the running `src/runtime.ts`, which is
 *  always two dirnames up from the package root in both cache installs
 *  and git checkouts — robust to both deployment shapes. */
let _versionCache: string | null = null;
export function getRuntimeVersion(): string | null {
  if (_versionCache !== null) {
    return _versionCache;
  }
  for (const root of candidatePluginRoots()) {
    try {
      const raw = readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf-8");
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version) {
        _versionCache = parsed.version;
        return _versionCache;
      }
    } catch {
      // try the next candidate
    }
  }
  // Fallback: a deployed plugin install may not expose a readable
  // `plugin.json` version at the running-code root, but the Claude CLI
  // always records one in `installed_plugins.json`.
  const version = getInstalledPluginRecord()?.version;
  if (version) {
    _versionCache = version;
    return _versionCache;
  }
  _versionCache = "";
  return null;
}

function candidatePluginRoots(): string[] {
  const roots: string[] = [];
  try {
    // import.meta.url → file:///…/src/runtime.ts. `new URL(".", ...)` gives
    // the src/ dir; one more `..` lands on the package root.
    const here = new URL(".", import.meta.url).pathname;
    roots.push(join(here, ".."));
  } catch {
    // import.meta not available in some test contexts — fall through.
  }
  roots.push(process.cwd());
  return roots;
}

/** The `~/.claude/plugins` directory. Derive it from the running code path
 *  first (robust even if `$HOME` is unusual on a deployment), then fall back
 *  to the home dir. Returns null when neither yields a path. */
function claudePluginsDir(): string | null {
  const marker = `${sep}.claude${sep}plugins`;
  for (const root of candidatePluginRoots()) {
    const idx = root.indexOf(marker);
    if (idx >= 0) {
      return root.slice(0, idx + marker.length);
    }
  }
  const home = homedir();
  return home ? join(home, ".claude", "plugins") : null;
}

/** Runtime identity recorded by the Claude CLI for a plugin install. */
interface InstalledPluginRecord {
  /** Installed semver, or null when absent / "unknown". */
  version: string | null;
  /** Full git commit sha the plugin was installed from, or null. This is the
   *  only source that carries a real git sha on a deployed plugin install —
   *  the cache dir itself has no `.git`. */
  gitCommitSha: string | null;
}

let _installedRecord: InstalledPluginRecord | null | undefined;

/**
 * Read the errandd entry from `~/.claude/plugins/installed_plugins.json`.
 * On a deployed plugin install the daemon runs from the plugin cache (no
 * `.git`, no readable `plugin.json` version in some layouts), so this file is
 * the most accurate runtime identity available — it carries both the version
 * and the real git commit sha. Returns null when this isn't a plugin install
 * or the file is missing/unreadable (e.g. a source checkout in dev).
 */
function getInstalledPluginRecord(): InstalledPluginRecord | null {
  if (_installedRecord !== undefined) {
    return _installedRecord;
  }
  _installedRecord = readInstalledPluginRecord();
  return _installedRecord;
}

function readInstalledPluginRecord(): InstalledPluginRecord | null {
  const info = detectPluginInstall();
  const dir = claudePluginsDir();
  if (!info || !dir) {
    return null;
  }
  try {
    const raw = readFileSync(join(dir, "installed_plugins.json"), "utf-8");
    const parsed = JSON.parse(raw) as {
      plugins?: Record<
        string,
        { installPath?: string; version?: unknown; gitCommitSha?: unknown }[]
      >;
    };
    const entries = parsed.plugins?.[`${info.plugin}@${info.marketplace}`];
    if (!Array.isArray(entries) || entries.length === 0) {
      return null;
    }
    // Prefer the entry whose installPath matches the running code; else first.
    const roots = candidatePluginRoots();
    const match =
      entries.find((e) => {
        const p = e.installPath;
        return typeof p === "string" && roots.some((r) => r.startsWith(p) || p.startsWith(r));
      }) ?? entries[0];
    const version =
      typeof match.version === "string" && match.version && match.version !== "unknown"
        ? match.version
        : null;
    const gitCommitSha =
      typeof match.gitCommitSha === "string" && /^[0-9a-f]{7,}$/i.test(match.gitCommitSha)
        ? match.gitCommitSha
        : null;
    return { version, gitCommitSha };
  } catch {
    return null;
  }
}

export async function getRuntimeGit(): Promise<RuntimeGit> {
  const now = Date.now();
  if (_gitCache && now - _gitCacheAt < GIT_TTL_MS) {
    return _gitCache;
  }

  const cwd = process.cwd();

  const statusOut = git(cwd, ["status", "--porcelain"]);
  const dirty = statusOut !== null && statusOut.length > 0;
  const remoteUrl = git(cwd, ["remote", "get-url", "origin"]);

  let repoUrl = remoteUrl ? parseGitHubRepoUrl(remoteUrl) : null;
  const tag = git(cwd, ["describe", "--tags", "--abbrev=0"]);
  const describe = git(cwd, ["describe", "--tags", "--always", "--dirty"]);

  // Resolve the build sha by priority so a deployed image/plugin still shows
  // a real identity on the About page:
  //   (1) ERRANDD_IMAGE_SHA — a CI-baked build-arg on the shipped image.
  //   (2) gitCommitSha the Claude CLI recorded for a plugin install
  //       (installed_plugins.json) — the only real sha on a plugin cache dir.
  //   (3) local git, when the running dir is an actual checkout (dev).
  let sha8: string | null = null;
  let fullSha: string | null = null;

  const imageSha = process.env.ERRANDD_IMAGE_SHA?.trim();
  if (imageSha && /^[0-9a-f]{7,}$/i.test(imageSha)) {
    fullSha = imageSha;
    sha8 = imageSha.slice(0, 8);
  }

  if (!sha8) {
    const rec = getInstalledPluginRecord();
    if (rec?.gitCommitSha) {
      fullSha = rec.gitCommitSha;
      sha8 = rec.gitCommitSha.slice(0, 8);
      const info = detectPluginInstall();
      if (info?.marketplaceRepo) {
        repoUrl = `https://github.com/${info.marketplaceRepo}`;
      }
    }
  }

  if (!sha8) {
    sha8 = git(cwd, ["rev-parse", "--short=8", "HEAD"]);
    fullSha = sha8 ? git(cwd, ["rev-parse", "HEAD"]) : null;
  }

  const commitUrl = repoUrl && fullSha ? `${repoUrl}/commit/${fullSha}` : null;

  _gitCache = { sha8, dirty, commitUrl, repoUrl, tag, describe };
  _gitCacheAt = now;
  return _gitCache;
}
