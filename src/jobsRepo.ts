import { existsSync } from "fs";
import { mkdir, rename } from "fs/promises";
import { join } from "path";
import {
  getSettings,
  getJobsRepoDirForRepo,
  slugForRepo,
  LEGACY_JOBS_REPO_DIR,
  JOBS_REPOS_PARENT_DIR,
  type JobsRepoConfig,
} from "./config";
import { discoverPluginsForDir, type JobsRepoPlugin } from "./jobsRepoPlugins";

export interface GitResult { ok: boolean; stdout: string; stderr: string; code: number; }

/**
 * Per-repo status — the canonical shape for multi-repo.
 * The legacy `JobsRepoStatus` type is kept as an alias for back-compat.
 */
export interface RepoStatus {
  slug: string;
  url: string;
  configured: boolean;
  cloned: boolean;
  dirty: boolean;
  ahead: number;
  behind: number;
  branch: string;
  dir: string;
  lastPullAt: string | null;
  lastError: string | null;
  plugins: JobsRepoPlugin[];
}

/** @deprecated Legacy single-repo status shape — use `RepoStatus` for new code. */
export type JobsRepoStatus = RepoStatus;

export interface SyncResult {
  ok: boolean;
  committed: boolean;
  pushed: boolean;
  message: string;
  error: string | null;
}

/** Run a git command in `cwd`. Never throws — returns ok=false on failure. */
export async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { ok: code === 0, stdout, stderr, code };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e), code: -1 };
  }
}

/** Parse `git status --porcelain` output. */
export function parseStatus(porcelain: string): { dirty: boolean } {
  return { dirty: porcelain.trim().length > 0 };
}

/** Auto-generated commit message for a UI-triggered sync. */
export function buildCommitMessage(now: Date = new Date()): string {
  return `clawdcode: sync jobs (${now.toISOString().replace("T", " ").slice(0, 19)} UTC)`;
}

// ---- Per-repo state ----
// keyed by slug
const perRepoState = new Map<string, { lastPullAt: string | null; lastError: string | null }>();

function getRepoState(slug: string) {
  if (!perRepoState.has(slug)) {
    perRepoState.set(slug, { lastPullAt: null, lastError: null });
  }
  return perRepoState.get(slug)!;
}

/** Derive the clone directory for a repo, migrating from the legacy path if needed. */
async function resolveRepoDir(repo: JobsRepoConfig): Promise<string> {
  const newDir = getJobsRepoDirForRepo(repo);
  // If the new dir already has a .git, use it.
  if (existsSync(join(newDir, ".git"))) return newDir;
  // If the legacy dir exists and this is the first (only) repo, migrate it.
  if (existsSync(join(LEGACY_JOBS_REPO_DIR, ".git"))) {
    const { jobsRepos } = getSettings();
    if (jobsRepos.length === 1) {
      try {
        await mkdir(JOBS_REPOS_PARENT_DIR, { recursive: true });
        await rename(LEGACY_JOBS_REPO_DIR, newDir);
        console.log(`[jobsRepo] migrated legacy jobs-repo → ${newDir}`);
      } catch {
        // If rename fails (e.g. cross-device), fall back to re-cloning at new path
      }
    }
  }
  return newDir;
}

// ---- Single-repo operations ----

/** Clone a repo if not yet present. */
export async function ensureRepo(repo: JobsRepoConfig): Promise<void> {
  if (!repo.url) return;
  const dir = await resolveRepoDir(repo);
  if (existsSync(join(dir, ".git"))) return;
  await mkdir(dir, { recursive: true }).catch(() => {});
  const res = await runGit(process.cwd(), ["clone", "--branch", repo.branch, repo.url, dir]);
  const slug = slugForRepo(repo.url);
  const state = getRepoState(slug);
  if (!res.ok) {
    state.lastError = `clone failed: ${res.stderr.trim()}`;
    console.warn(`[jobsRepo:${slug}] ${state.lastError}`);
  } else {
    state.lastError = null;
    console.log(`[jobsRepo:${slug}] cloned ${repo.url} (${repo.branch})`);
  }
}

/** Fast-forward pull — skips dirty trees. Clones first if the repo
 *  isn't on disk yet so a "Sync" button works end-to-end on a fresh repo
 *  without a separate "Clone" affordance. */
export async function pullRepo(repo: JobsRepoConfig): Promise<RepoStatus> {
  const slug = slugForRepo(repo.url);
  const state = getRepoState(slug);
  if (!repo.url) return getRepoStatus(repo);
  let dir = await resolveRepoDir(repo);
  if (!existsSync(join(dir, ".git"))) {
    await ensureRepo(repo);
    dir = await resolveRepoDir(repo);
    if (!existsSync(join(dir, ".git"))) {
      // ensureRepo wrote `state.lastError`; surface that to the caller.
      return getRepoStatus(repo);
    }
  }

  const st = await runGit(dir, ["status", "--porcelain"]);
  if (parseStatus(st.stdout).dirty) {
    state.lastError = "local job edits not synced — pull skipped";
    return getRepoStatus(repo);
  }
  const fetched = await runGit(dir, ["fetch", "origin", repo.branch]);
  if (!fetched.ok) {
    state.lastError = `fetch failed: ${fetched.stderr.trim()}`;
    return getRepoStatus(repo);
  }
  const merged = await runGit(dir, ["merge", "--ff-only", `origin/${repo.branch}`]);
  if (!merged.ok) {
    state.lastError = `merge failed: ${merged.stderr.trim()}`;
    return getRepoStatus(repo);
  }
  state.lastError = null;
  state.lastPullAt = new Date().toISOString();
  return getRepoStatus(repo);
}

/** Stage everything, commit, and push. */
export async function syncRepo(repo: JobsRepoConfig): Promise<SyncResult> {
  const slug = slugForRepo(repo.url);
  const state = getRepoState(slug);
  if (!repo.url) {
    return { ok: false, committed: false, pushed: false, message: "", error: "jobs repo not configured" };
  }
  const dir = await resolveRepoDir(repo);
  if (!existsSync(join(dir, ".git"))) {
    return { ok: false, committed: false, pushed: false, message: "", error: "jobs repo not configured" };
  }
  await runGit(dir, ["add", "-A"]);
  const status = await runGit(dir, ["status", "--porcelain"]);
  const message = buildCommitMessage();
  let committed = false;
  if (parseStatus(status.stdout).dirty) {
    const commit = await runGit(dir, ["commit", "-m", message]);
    if (!commit.ok) {
      return { ok: false, committed: false, pushed: false, message, error: commit.stderr.trim() };
    }
    committed = true;
  }
  const push = await runGit(dir, ["push", "origin", repo.branch]);
  if (!push.ok) {
    return { ok: false, committed, pushed: false, message, error: push.stderr.trim() };
  }
  state.lastError = null;
  return { ok: true, committed, pushed: true, message, error: null };
}

/** Get the current status of a repo. */
export async function getRepoStatus(repo: JobsRepoConfig): Promise<RepoStatus> {
  const slug = slugForRepo(repo.url);
  const state = getRepoState(slug);
  const dir = await resolveRepoDir(repo);
  const cloned = existsSync(join(dir, ".git"));
  let dirty = false, ahead = 0, behind = 0;
  if (cloned) {
    const st = await runGit(dir, ["status", "--porcelain"]);
    dirty = parseStatus(st.stdout).dirty;
    const counts = await runGit(dir, [
      "rev-list", "--left-right", "--count", `HEAD...origin/${repo.branch}`,
    ]);
    if (counts.ok) {
      const [a, b] = counts.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
      ahead = a ?? 0; behind = b ?? 0;
    }
  }
  const plugins = await discoverPluginsForDir(dir, !!repo.url);
  return {
    slug,
    url: repo.url,
    configured: !!repo.url,
    cloned, dirty, ahead, behind,
    branch: repo.branch,
    dir,
    lastPullAt: state.lastPullAt,
    lastError: state.lastError,
    plugins,
  };
}

// ---- Multi-repo operations ----

function getConfiguredRepos(): JobsRepoConfig[] {
  return getSettings().jobsRepos.filter((r) => r.url);
}

/** Clone all repos in parallel. */
export async function ensureAllRepos(): Promise<void> {
  await Promise.all(getConfiguredRepos().map(ensureRepo));
}

/** Pull all repos — errors per-repo, never throws. */
export async function pullAllRepos(): Promise<RepoStatus[]> {
  const repos = getConfiguredRepos();
  const results: RepoStatus[] = [];
  for (const repo of repos) {
    try {
      results.push(await pullRepo(repo));
    } catch (e) {
      const slug = slugForRepo(repo.url);
      const state = getRepoState(slug);
      state.lastError = String(e);
      console.warn(`[jobsRepo:${slug}] pull error: ${state.lastError}`);
      results.push(await getRepoStatus(repo));
    }
  }
  return results;
}

/** Get status for all configured repos. */
export async function getAllRepoStatuses(): Promise<RepoStatus[]> {
  return Promise.all(getConfiguredRepos().map(getRepoStatus));
}

/** Find a repo by slug. */
export function findRepoBySlug(slug: string): JobsRepoConfig | null {
  const repos = getConfiguredRepos();
  // Build slugs with collision avoidance
  const seen = new Set<string>();
  for (const repo of repos) {
    const s = slugForRepo(repo.url, seen);
    seen.add(s);
    if (s === slug) return repo;
  }
  return null;
}

// ---- Legacy single-repo API (back-compat for callers that haven't migrated) ----

/** @deprecated Use ensureAllRepos() for multi-repo. */
export async function ensureJobsRepo(): Promise<void> {
  return ensureAllRepos();
}

/** @deprecated Use pullAllRepos() for multi-repo. */
export async function pullJobsRepo(): Promise<RepoStatus> {
  const repos = getConfiguredRepos();
  if (repos.length === 0) return legacyEmptyStatus();
  const results = await pullAllRepos();
  return results[0] ?? legacyEmptyStatus();
}

/** @deprecated Use syncRepo(repo) for multi-repo. */
export async function syncJobsRepo(): Promise<SyncResult> {
  const repos = getConfiguredRepos();
  if (repos.length === 0) {
    return { ok: false, committed: false, pushed: false, message: "", error: "jobs repo not configured" };
  }
  return syncRepo(repos[0]);
}

/** @deprecated Use getAllRepoStatuses() or getRepoStatus(repo) for multi-repo. */
export async function getJobsRepoStatus(): Promise<RepoStatus> {
  const repos = getConfiguredRepos();
  if (repos.length === 0) return legacyEmptyStatus();
  return getRepoStatus(repos[0]);
}

function legacyEmptyStatus(): RepoStatus {
  return {
    slug: "",
    url: "",
    configured: false,
    cloned: false,
    dirty: false,
    ahead: 0,
    behind: 0,
    branch: "main",
    dir: "",
    lastPullAt: null,
    lastError: null,
    plugins: [],
  };
}
