/**
 * Runtime environment helpers — git SHA, dirty flag, and GitHub repo URL
 * for the running daemon's working directory.
 *
 * Results are cached in-process for 30 s to avoid hitting git per request.
 */

import { spawnSync } from "child_process";

export interface RuntimeGit {
  sha8: string | null;
  dirty: boolean;
  commitUrl: string | null;
  repoUrl: string | null;
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
    if (r.status !== 0 || r.error) return null;
    return r.stdout.trim();
  } catch {
    return null;
  }
}

function parseGitHubRepoUrl(remote: string): string | null {
  if (!remote) return null;
  // https://github.com/owner/repo(.git)?
  const https = remote.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/.*)?$/);
  if (https) return `https://github.com/${https[1]}`;
  // git@github.com:owner/repo(.git)?
  const ssh = remote.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (ssh) return `https://github.com/${ssh[1]}`;
  // ssh://git@github.com/owner/repo(.git)?
  const sshUrl = remote.match(/^ssh:\/\/git@github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/.*)?$/);
  if (sshUrl) return `https://github.com/${sshUrl[1]}`;
  return null;
}

export async function getRuntimeGit(): Promise<RuntimeGit> {
  const now = Date.now();
  if (_gitCache && now - _gitCacheAt < GIT_TTL_MS) return _gitCache;

  const cwd = process.cwd();

  const sha8 = git(cwd, ["rev-parse", "--short=8", "HEAD"]);
  const fullSha = sha8 ? git(cwd, ["rev-parse", "HEAD"]) : null;
  const statusOut = git(cwd, ["status", "--porcelain"]);
  const dirty = statusOut !== null && statusOut.length > 0;
  const remoteUrl = git(cwd, ["remote", "get-url", "origin"]);

  const repoUrl = remoteUrl ? parseGitHubRepoUrl(remoteUrl) : null;
  const commitUrl =
    repoUrl && fullSha ? `${repoUrl}/commit/${fullSha}` : null;

  _gitCache = { sha8, dirty, commitUrl, repoUrl };
  _gitCacheAt = now;
  return _gitCache;
}
