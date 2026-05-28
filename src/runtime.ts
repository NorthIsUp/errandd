/**
 * Runtime environment helpers — git SHA, dirty flag, and GitHub repo URL
 * for the running daemon's working directory.
 *
 * Results are cached in-process for 30 s to avoid hitting git per request.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  /** SHA the daemon is running. */
  currentSha: string | null;
  /** SHA at origin/<branch>. */
  latestSha: string | null;
  /** Number of commits the local HEAD is behind origin. 0 = up to date. */
  behind: number;
  /** Branch name we compared against (usually `master`). */
  branch: string;
  /** True if the daemon can perform `git pull --ff-only` itself — false in
   *  container deployments where the source is baked into the image. */
  canPull: boolean;
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

  // No .git in the working tree → container/binary deployment. Can't pull.
  if (currentSha === null) {
    const out: UpdateCheck = {
      currentSha: null,
      latestSha: null,
      behind: 0,
      branch,
      canPull: false,
      compareUrl: null,
      error: "not a git checkout — redeploy the image / binary to update",
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
    currentSha,
    latestSha,
    behind,
    branch,
    canPull: true,
    compareUrl,
    error: fetchError,
  };
  _updateCache = out;
  _updateCacheAt = now;
  return out;
}

/** Result of `git pull --ff-only`. */
export interface UpdateResult {
  ok: boolean;
  newSha: string | null;
  output: string;
  error: string | null;
}

/**
 * Perform a fast-forward pull. Returns the new HEAD on success. The
 * daemon needs a manual restart afterwards — we don't self-restart
 * because the running process can't cleanly swap its own code.
 */
// biome-ignore lint/suspicious/useAwait: keeping signature async — `spawnSync` is sync today but we may switch to streaming output later.
export async function applyUpdate(): Promise<UpdateResult> {
  const cwd = process.cwd();
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
