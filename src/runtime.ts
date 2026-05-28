/**
 * Runtime environment helpers — git SHA, dirty flag, and GitHub repo URL
 * for the running daemon's working directory.
 *
 * Results are cached in-process for 30 s to avoid hitting git per request.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  const https = remote.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/.*)?$/);
  if (https) {
    return `https://github.com/${https[1]}`;
  }
  // git@github.com:owner/repo(.git)?
  const ssh = remote.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (ssh) {
    return `https://github.com/${ssh[1]}`;
  }
  // ssh://git@github.com/owner/repo(.git)?
  const sshUrl = remote.match(/^ssh:\/\/git@github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/.*)?$/);
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
      currentSha: null,
      latestSha: null,
      behind: 0,
      branch: "",
      canPull: false,
      canPlugin: false,
      updateCommand: null,
      compareUrl: null,
      error: "deployed image / binary — pull a newer build to update",
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

/**
 * When the daemon is running as a Claude Code plugin install, the working
 * directory is something like `~/.claude/plugins/marketplaces/<slug>/clawdcode/`.
 * Detect that layout, fetch the marketplace manifest from
 * raw.githubusercontent.com, and compare local version to upstream so we
 * can offer `claude plugin update clawdcode` as the action.
 *
 * Returns null when this isn't a plugin install — caller falls through to
 * the "redeploy the image" path.
 */
async function checkPluginUpdate(): Promise<UpdateCheck | null> {
  const cwd = process.cwd();
  // Plugin installs live under `<...>/.claude/plugins/<...>`. If the path
  // doesn't contain that segment we're not a plugin.
  if (!cwd.includes(`${sep}.claude${sep}plugins${sep}`)) {
    return null;
  }
  const local = getRuntimeVersion();
  if (!local) {
    return null;
  }

  // Fetch upstream marketplace.json. We hard-code the repo because the
  // plugin install doesn't carry an "origin" URL like git does. This is
  // the canonical source for the marketplace; forks publishing under a
  // different name will need their own update channel anyway.
  let latest: string | null = null;
  let fetchError: string | null = null;
  try {
    const resp = await fetch(
      "https://raw.githubusercontent.com/NorthIsUp/clawdcode/master/.claude-plugin/marketplace.json",
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!resp.ok) {
      fetchError = `marketplace fetch failed: HTTP ${resp.status}`;
    } else {
      const body = (await resp.json()) as { version?: unknown };
      latest = typeof body.version === "string" ? body.version : null;
    }
  } catch (e) {
    fetchError = `marketplace fetch failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  const behind = latest && latest !== local ? compareVersions(local, latest) : 0;
  return {
    kind: "plugin",
    currentSha: local,
    latestSha: latest,
    behind,
    branch: "",
    canPull: false,
    canPlugin: true,
    updateCommand: "claude plugin update clawdcode",
    compareUrl: null,
    error: fetchError,
  };
}

/** Returns the number of "behind" steps when local < latest, else 0.
 *  Simple semver-ish compare: split on `.`, compare numerically. */
function compareVersions(local: string, latest: string): number {
  const a = local.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const b = latest.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x < y) return y - x;
    if (x > y) return 0;
  }
  return 0;
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
 *   - claude plugin install → `claude plugin update clawdcode`
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
  const r = spawnSync("claude", ["plugin", "update", "clawdcode"], {
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
 *  runtime, so a single read on first access is sufficient. */
let _versionCache: string | null = null;
export function getRuntimeVersion(): string | null {
  if (_versionCache !== null) {
    return _versionCache;
  }
  try {
    const raw = readFileSync(join(process.cwd(), ".claude-plugin", "plugin.json"), "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    _versionCache = typeof parsed.version === "string" ? parsed.version : "";
  } catch {
    _versionCache = "";
  }
  return _versionCache || null;
}

export async function getRuntimeGit(): Promise<RuntimeGit> {
  const now = Date.now();
  if (_gitCache && now - _gitCacheAt < GIT_TTL_MS) {
    return _gitCache;
  }

  const cwd = process.cwd();

  const sha8 = git(cwd, ["rev-parse", "--short=8", "HEAD"]);
  const fullSha = sha8 ? git(cwd, ["rev-parse", "HEAD"]) : null;
  const statusOut = git(cwd, ["status", "--porcelain"]);
  const dirty = statusOut !== null && statusOut.length > 0;
  const remoteUrl = git(cwd, ["remote", "get-url", "origin"]);

  const repoUrl = remoteUrl ? parseGitHubRepoUrl(remoteUrl) : null;
  const commitUrl = repoUrl && fullSha ? `${repoUrl}/commit/${fullSha}` : null;

  const tag = git(cwd, ["describe", "--tags", "--abbrev=0"]);
  const describe = git(cwd, ["describe", "--tags", "--always", "--dirty"]);

  _gitCache = { sha8, dirty, commitUrl, repoUrl, tag, describe };
  _gitCacheAt = now;
  return _gitCache;
}
