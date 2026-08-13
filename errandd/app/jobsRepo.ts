import { existsSync } from "fs";
import { copyFile, mkdir, rename } from "fs/promises";
import { dirname, join } from "path";
import {
  getSettings,
  getJobsRepoDirForRepo,
  slugForRepo,
  LEGACY_JOBS_REPO_DIR,
  JOBS_REPOS_PARENT_DIR,
  JOBS_DISCARDED_DIR,
  type JobsRepoConfig,
} from "./config";
import { discoverPluginsForDir, type JobsRepoPlugin } from "./jobsRepoPlugins";

export interface GitResult { ok: boolean; stdout: string; stderr: string; code: number; }

/** The repo's stable slug — computed once at config parse with
 *  collision-avoidance and stored on the config. Falls back to a bare
 *  `slugForRepo(url)` only for configs built outside the parser (tests/env). */
function repoSlug(repo: JobsRepoConfig): string {
  return repo.slug ?? slugForRepo(repo.url);
}

/** Per-repo status — the canonical shape for multi-repo. */
export interface RepoStatus {
  slug: string;
  kind: "git" | "plugin";
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
  /** ISO timestamp of the last pull that had to wipe local edits, or null. */
  lastForcedAt: string | null;
  /** What that wipe threw away. Kept so a human checking repo status sees the
   *  destruction, which `lastError` (cleared on success) cannot show. */
  lastDiscarded: DiscardedEdits | null;
  plugins: JobsRepoPlugin[];
  /** Count of `.md` files at the source root — errandd treats those as
   *  candidate routines. Surfaced separately from plugins because routines
   *  live at the top level, not nested inside a `.claude-plugin/` plugin. */
  jobs: number;
}

/** A snapshot of the working-tree changes a force-resync destroyed. */
export interface DiscardedEdits {
  at: string;
  count: number;
  /** Raw `git status --porcelain` lines, so the status codes survive too. */
  entries: string[];
  /** Where the files were copied, or null if the backup itself failed. */
  backupDir: string | null;
}

export interface SyncResult {
  ok: boolean;
  committed: boolean;
  pushed: boolean;
  message: string;
  error: string | null;
}

/** Run a git command in `cwd`. Never throws — returns ok=false on failure.
 *
 *  Always injects `-c user.name=... -c user.email=...` so commits work in
 *  containerized deployments where the global git config is empty.
 *
 *  Credential-helper handling is opt-out via the
 *  `ERRANDD_GIT_KEEP_CREDENTIAL_HELPER` env var. By default we still
 *  inject `-c credential.helper=` so the published Docker image's
 *  bundled `gh` doesn't hijack every clone and return 403 against repos
 *  the App can't see (the original rationale). Set the env var to a
 *  truthy value (`1` / `true` / `yes`) to preserve any helper the user
 *  intentionally set up (e.g. via `gh auth setup-git` so the daemon can
 *  reach private HTTPS repos). */
function shouldKeepInheritedCredentialHelper(): boolean {
  const raw = (process.env.ERRANDD_GIT_KEEP_CREDENTIAL_HELPER ?? "").toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Repo-pointing git env vars override `cwd` entirely, so inheriting them makes
 *  every jobs-repo command silently operate on whatever repo the parent process
 *  was in — a git hook, a `git rebase --exec`, an IDE. Drop them. */
function gitEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"]) {
    delete env[key];
  }
  return env;
}

export async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    // The configured identity when present; otherwise fall back to the defaults
    // below rather than throwing — a git op shouldn't hard-fail just because
    // settings init hasn't run (getSettings() throws) OR the loaded settings
    // carry no `git` block (getSettings().git is undefined). Optional-chain both.
    let git: { name?: string; email?: string } | undefined;
    try {
      git = getSettings().git;
    } catch {
      /* settings not loaded — use defaults */
    }
    const name = git?.name;
    const email = git?.email;
    const config = [
      "-c", `user.name=${name || "Errandd"}`,
      "-c", `user.email=${email || "errandd@localhost"}`,
      // Headless daemon: never attempt to sign jobs-repo commits. A host with
      // commit.gpgsign on but no available signer (k8s pod, or a laptop whose
      // signing agent declines) would otherwise hang/fail the whole sync.
      "-c", "commit.gpgsign=false",
    ];
    if (!shouldKeepInheritedCredentialHelper()) {
      config.push("-c", "credential.helper=");
    }
    const proc = Bun.spawn(["git", ...config, ...args], { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { ok: code === 0, stdout, stderr, code };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e), code: -1 };
  }
}

/** `-unormal` is not the default it looks like: a host with
 *  `status.showUntrackedFiles=no` in its git config hides untracked files from
 *  porcelain, so the daemon would call the tree clean while `clean -fd` still
 *  deletes them — a silent wipe. Ask for them explicitly. */
const STATUS_ARGS = ["status", "--porcelain", "-unormal"];

/** Parse `git status --porcelain` output. */
export function parseStatus(porcelain: string): { dirty: boolean } {
  return { dirty: porcelain.trim().length > 0 };
}

/** Pull the working-tree-side path out of each `git status --porcelain` line.
 *  Renames (`R  old -> new`) yield the destination; paths git quoted because
 *  they contain odd bytes are unquoted (its C escapes are a JSON subset). */
export function parsePorcelainPaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    const raw = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    if (!raw) continue;
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        paths.push(JSON.parse(raw) as string);
        continue;
      } catch {
        /* fall through to the raw form */
      }
    }
    paths.push(raw);
  }
  return paths;
}

/** Auto-generated commit message for a UI-triggered sync. */
export function buildCommitMessage(now: Date = new Date()): string {
  return `errandd: sync jobs (${now.toISOString().replace("T", " ").slice(0, 19)} UTC)`;
}

// ---- Per-repo state ----
// keyed by slug
interface RepoState {
  lastPullAt: string | null;
  lastError: string | null;
  lastForcedAt: string | null;
  lastDiscarded: DiscardedEdits | null;
}

const perRepoState = new Map<string, RepoState>();

function getRepoState(slug: string): RepoState {
  if (!perRepoState.has(slug)) {
    perRepoState.set(slug, { lastPullAt: null, lastError: null, lastForcedAt: null, lastDiscarded: null });
  }
  return perRepoState.get(slug)!;
}

interface ClaudeMarketplace {
  name: string;
  repo?: string;
  url?: string;
  installLocation: string;
}

interface ClaudePluginInstall {
  id: string; // "<plugin>@<marketplace>"
  installPath: string;
}

async function runClaude(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(["claude", ...args], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { ok: code === 0, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e) };
  }
}

/** Look up an added marketplace by GitHub `<org>/<repo>` ref via
 *  `claude plugin marketplace list --json`. Matches case-insensitively
 *  against the `repo` field (e.g. "NorthIsUp/skillz"). */
async function resolveMarketplaceByRef(ref: string): Promise<ClaudeMarketplace | null> {
  const r = await runClaude(["plugin", "marketplace", "list", "--json"]);
  if (!r.ok) return null;
  try {
    const list = JSON.parse(r.stdout) as ClaudeMarketplace[];
    const lc = ref.toLowerCase();
    return (
      list.find((m) => (m.repo ?? "").toLowerCase() === lc) ??
      list.find((m) => (m.url ?? "").toLowerCase().includes(lc)) ??
      null
    );
  } catch {
    return null;
  }
}

async function listClaudePlugins(): Promise<ClaudePluginInstall[]> {
  const r = await runClaude(["plugin", "list", "--json"]);
  if (!r.ok) return [];
  try {
    const list = JSON.parse(r.stdout) as { id?: unknown; installPath?: unknown }[];
    return list
      .filter((p) => typeof p.id === "string" && typeof p.installPath === "string")
      .map((p) => ({ id: p.id as string, installPath: p.installPath as string }));
  } catch {
    return [];
  }
}

/** Read the marketplace.json at <installLocation>/.claude-plugin/marketplace.json
 *  and return the listed plugin names. */
async function readMarketplacePlugins(installLocation: string): Promise<string[]> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(
      join(installLocation, ".claude-plugin", "marketplace.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as { plugins?: { name?: string }[] };
    return (parsed.plugins ?? [])
      .map((p) => p?.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
  } catch {
    return [];
  }
}

/** Derive the source directory for a repo, migrating from the legacy path if needed. */
async function resolveRepoDir(repo: JobsRepoConfig): Promise<string> {
  if (repo.kind === "plugin") {
    // For plugin sources, the source dir is the marketplace clone under
    // ~/.claude/plugins/marketplaces/<name>/. We use that as the root so
    // discoverPluginsForDir() can walk the marketplace's plugins/ subdir
    // and pick up every contained plugin. If the marketplace isn't added
    // yet, fall back to an expected path so existsSync-checks return
    // false and ensureRepo will run the add.
    const mp = await resolveMarketplaceByRef(repo.url);
    if (mp) return mp.installLocation;
    const inferred = repo.url.split("/").pop() ?? "_";
    return join(process.env.HOME ?? "", ".claude", "plugins", "marketplaces", inferred);
  }
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

/** Clone (kind=git) or install (kind=plugin) a repo if not yet present. */
export async function ensureRepo(repo: JobsRepoConfig): Promise<void> {
  if (!repo.url) return;
  const slug = repoSlug(repo);
  const state = getRepoState(slug);

  if (repo.kind === "plugin") {
    // Three steps:
    //   1. `claude plugin marketplace add <org/repo>` — idempotent; we don't
    //      try to short-circuit because the cost is small and `add` will
    //      no-op when already present.
    //   2. Resolve the marketplace install dir + name from
    //      `claude plugin marketplace list --json`.
    //   3. For each plugin listed in the marketplace.json, run
    //      `claude plugin install <plugin>@<marketplace>`.
    const addRes = await runClaude(["plugin", "marketplace", "add", repo.url]);
    if (!addRes.ok && !addRes.stderr.toLowerCase().includes("already")) {
      state.lastError = `marketplace add failed: ${addRes.stderr.trim() || "non-zero exit"}`;
      console.warn(`[jobsRepo:${slug}] ${state.lastError}`);
      return;
    }
    const mp = await resolveMarketplaceByRef(repo.url);
    if (!mp) {
      state.lastError = `marketplace resolution failed after add`;
      console.warn(`[jobsRepo:${slug}] ${state.lastError}`);
      return;
    }
    const pluginNames = await readMarketplacePlugins(mp.installLocation);
    if (pluginNames.length === 0) {
      state.lastError = `no plugins listed in marketplace ${mp.name}`;
      console.warn(`[jobsRepo:${slug}] ${state.lastError}`);
      return;
    }
    const installed: ClaudePluginInstall[] = await listClaudePlugins();
    for (const pluginName of pluginNames) {
      const id = `${pluginName}@${mp.name}`;
      if (installed.some((p) => p.id === id)) continue;
      const r = await runClaude(["plugin", "install", id]);
      if (!r.ok) {
        state.lastError = `claude plugin install ${id} failed: ${r.stderr.trim() || "non-zero exit"}`;
        console.warn(`[jobsRepo:${slug}] ${state.lastError}`);
        // keep going — partial install is better than none
      }
    }
    state.lastError = state.lastError ?? null;
    if (!state.lastError) {
      console.log(`[jobsRepo:${slug}] marketplace ${mp.name} ready (${pluginNames.length} plugin(s))`);
    }
    return;
  }

  const dir = await resolveRepoDir(repo);
  if (existsSync(join(dir, ".git"))) return;
  await mkdir(dir, { recursive: true }).catch(() => {});
  const res = await runGit(process.cwd(), ["clone", "--branch", repo.branch, repo.url, dir]);
  if (!res.ok) {
    state.lastError = `clone failed: ${res.stderr.trim()}`;
    console.warn(`[jobsRepo:${slug}] ${state.lastError}`);
  } else {
    state.lastError = null;
    console.log(`[jobsRepo:${slug}] cloned ${repo.url} (${repo.branch})`);
  }
}

/** Fast-forward pull, force-resyncing instead of skipping when the tree is
 *  dirty — local edits are backed up to `<state>/discarded/` and then wiped, so
 *  a stray edit can never freeze routine sync again (2026-08-12: one
 *  uncommitted line held the daemon 9 commits behind origin for 22 hours).
 *  Clones first if the repo isn't on disk yet so a "Sync" button works
 *  end-to-end on a fresh repo without a separate "Clone" affordance. */
export async function pullRepo(repo: JobsRepoConfig): Promise<RepoStatus> {
  const slug = repoSlug(repo);
  const state = getRepoState(slug);
  if (!repo.url) return getRepoStatus(repo);

  // Plugin pull = refresh the marketplace clone (which doubles as the
  // source dir we scan) and update each installed plugin from it.
  if (repo.kind === "plugin") {
    await ensureRepo(repo);
    const mp = await resolveMarketplaceByRef(repo.url);
    if (!mp) {
      state.lastError = "marketplace not added";
      return getRepoStatus(repo);
    }
    // Refresh the marketplace clone (git pull under the hood).
    const refresh = await runClaude(["plugin", "marketplace", "update", mp.name]);
    if (!refresh.ok) {
      state.lastError = `marketplace update failed: ${refresh.stderr.trim() || "non-zero exit"}`;
      return getRepoStatus(repo);
    }
    const pluginNames = await readMarketplacePlugins(mp.installLocation);
    for (const pluginName of pluginNames) {
      const id = `${pluginName}@${mp.name}`;
      const r = await runClaude(["plugin", "update", id]);
      if (!r.ok) {
        // First update on a fresh marketplace might be `install` not `update`.
        const inst = await runClaude(["plugin", "install", id]);
        if (!inst.ok) {
          state.lastError = `${id}: ${(r.stderr || inst.stderr).trim() || "failed"}`;
        }
      }
    }
    if (!state.lastError) {
      state.lastError = null;
      state.lastPullAt = new Date().toISOString();
    }
    return getRepoStatus(repo);
  }

  let dir = await resolveRepoDir(repo);
  if (!existsSync(join(dir, ".git"))) {
    await ensureRepo(repo);
    dir = await resolveRepoDir(repo);
    if (!existsSync(join(dir, ".git"))) {
      // ensureRepo wrote `state.lastError`; surface that to the caller.
      return getRepoStatus(repo);
    }
  }

  // Fetch FIRST (read-only, safe even on a dirty tree). A dirty tree blocks the
  // ff-merge below, but fetching keeps `origin/<branch>` current so the `behind`
  // count is accurate — otherwise a dirty repo shows "behind 0" and looks
  // healthy while it silently freezes ALL job-definition sync (2026-07-03: a
  // stray `nightly-refactor.md` edit in the pod froze sync for days).
  const fetched = await runGit(dir, ["fetch", "origin", repo.branch]);
  if (!fetched.ok) {
    state.lastError = `fetch failed: ${fetched.stderr.trim()}`;
    return getRepoStatus(repo);
  }
  const st = await runGit(dir, STATUS_ARGS);
  if (parseStatus(st.stdout).dirty) {
    // Force, don't freeze. The clone is a mirror of git, so a local edit is
    // never the source of truth — and skipping the pull to protect one used to
    // stall every routine definition for as long as the edit sat there.
    await forceResetToOrigin(dir, repo, slug, { alreadyFetched: true, porcelain: st.stdout });
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

/** Copy every dirty path to `<state>/discarded/<slug>/<stamp>/` before it is
 *  wiped. Best-effort: a failed copy still lets the reset proceed, because a
 *  frozen sync is the worse outcome — the backup is a courtesy, not a gate. */
async function backupDirtyTree(dir: string, slug: string, porcelain: string): Promise<DiscardedEdits> {
  const at = new Date().toISOString();
  const entries = porcelain.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const paths = parsePorcelainPaths(porcelain);
  const backupDir = join(JOBS_DISCARDED_DIR, slug, at.replace(/[:.]/g, "-"));
  try {
    for (const rel of paths) {
      const src = join(dir, rel);
      if (!existsSync(src)) continue; // deleted-in-worktree — nothing to copy
      const dest = join(backupDir, rel);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(src, dest);
    }
    await Bun.write(join(backupDir, "git-status.txt"), porcelain);
    return { at, count: entries.length, entries, backupDir };
  } catch (e) {
    console.warn(`[jobsRepo:${slug}] backup of discarded edits failed: ${String(e)}`);
    return { at, count: entries.length, entries, backupDir: null };
  }
}

/** Fetch, back up anything dirty, then make the clone byte-identical to
 *  `origin/<branch>` via `reset --hard` + `clean -fd`.
 *
 *  Shared by the scheduled pull and the manual force-resync so both wipe the
 *  same way and record the same `lastForcedAt` / `lastDiscarded` evidence.
 *  Pass `porcelain` when the caller already ran `status --porcelain`. */
async function forceResetToOrigin(
  dir: string,
  repo: JobsRepoConfig,
  slug: string,
  opts: { alreadyFetched?: boolean; porcelain?: string } = {},
): Promise<boolean> {
  const state = getRepoState(slug);
  if (!opts.alreadyFetched) {
    const fetched = await runGit(dir, ["fetch", "origin", repo.branch]);
    if (!fetched.ok) {
      state.lastError = `fetch failed: ${fetched.stderr.trim()}`;
      return false;
    }
  }
  const porcelain = opts.porcelain ?? (await runGit(dir, STATUS_ARGS)).stdout;
  if (parseStatus(porcelain).dirty) {
    const discarded = await backupDirtyTree(dir, slug, porcelain);
    state.lastForcedAt = discarded.at;
    state.lastDiscarded = discarded;
    console.warn(
      `[jobsRepo:${slug}] ⚠️ force-resync to origin/${repo.branch} — DISCARDING ${discarded.count} local change(s); ` +
        (discarded.backupDir ? `backup: ${discarded.backupDir}` : "backup FAILED, changes are gone") +
        `\n${discarded.entries.join("\n")}`,
    );
  }
  const reset = await runGit(dir, ["reset", "--hard", `origin/${repo.branch}`]);
  if (!reset.ok) {
    state.lastError = `reset failed: ${reset.stderr.trim()}`;
    return false;
  }
  // Remove untracked cruft too (a leftover file also counts as "dirty").
  await runGit(dir, ["clean", "-fd"]);
  state.lastError = null;
  state.lastPullAt = new Date().toISOString();
  return true;
}

/**
 * Force-resync: DISCARD local working-tree edits and hard-reset to origin.
 *
 * Same wipe the scheduled pull now performs on a dirty tree; kept as an
 * explicit route so a human can trigger it on demand (e.g. to recover a clone
 * wedged mid-rebase) without waiting for the poll interval.
 */
export async function resetRepo(repo: JobsRepoConfig): Promise<RepoStatus> {
  const slug = repoSlug(repo);
  if (!repo.url) return getRepoStatus(repo);

  let dir = await resolveRepoDir(repo);
  if (!existsSync(join(dir, ".git"))) {
    await ensureRepo(repo);
    dir = await resolveRepoDir(repo);
    if (!existsSync(join(dir, ".git"))) {
      return getRepoStatus(repo);
    }
  }

  await forceResetToOrigin(dir, repo, slug);
  return getRepoStatus(repo);
}

/** Clone-if-missing, then stage / commit / push. The "Sync" button is the
 *  catch-all "push my edits" affordance, so it has to be end-to-end safe
 *  on a fresh repo too — no separate Clone step. We must NOT pull *before*
 *  committing: callers like the save+push button hand us a dirty tree, and
 *  pullRepo now force-wipes one. Instead, if the push is rejected because the
 *  remote moved ahead, we rebase our commit onto it and retry once. */
export async function syncRepo(repo: JobsRepoConfig): Promise<SyncResult> {
  const slug = repoSlug(repo);
  const state = getRepoState(slug);
  if (!repo.url) {
    return { ok: false, committed: false, pushed: false, message: "", error: "jobs repo not configured" };
  }
  // Plugin "sync" = plugin update. Read-only install, nothing to push.
  if (repo.kind === "plugin") {
    await pullRepo(repo);
    if (state.lastError) {
      return { ok: false, committed: false, pushed: false, message: "", error: state.lastError };
    }
    return { ok: true, committed: false, pushed: false, message: "plugin updated", error: null };
  }
  let dir = await resolveRepoDir(repo);
  if (!existsSync(join(dir, ".git"))) {
    await ensureRepo(repo);
    dir = await resolveRepoDir(repo);
    if (!existsSync(join(dir, ".git"))) {
      return { ok: false, committed: false, pushed: false, message: "", error: state.lastError ?? "clone failed" };
    }
  }
  await runGit(dir, ["add", "-A"]);
  const status = await runGit(dir, STATUS_ARGS);
  const message = buildCommitMessage();
  let committed = false;
  if (parseStatus(status.stdout).dirty) {
    const commit = await runGit(dir, ["commit", "-m", message]);
    if (!commit.ok) {
      return { ok: false, committed: false, pushed: false, message, error: commit.stderr.trim() };
    }
    committed = true;
  }
  let push = await runGit(dir, ["push", "origin", repo.branch]);
  if (!push.ok && isNonFastForward(push.stderr)) {
    // The remote moved ahead since we cloned/pulled (another routine edit
    // landed, or a prior push half-succeeded), so this is a non-fast-forward
    // rejection. Rebase our commit onto the latest remote and retry once —
    // routine edits touch one file and rarely conflict. If the rebase does
    // conflict, abort cleanly and surface a clear message instead of leaving
    // the clone mid-rebase.
    const rebased = await runGit(dir, ["pull", "--rebase", "origin", repo.branch]);
    if (!rebased.ok) {
      await runGit(dir, ["rebase", "--abort"]); // best-effort; no-op if not rebasing
      state.lastError = `remote changed and the automatic rebase conflicted — resolve by hand: ${rebased.stderr.trim()}`;
      return { ok: false, committed, pushed: false, message, error: state.lastError };
    }
    push = await runGit(dir, ["push", "origin", repo.branch]);
  }
  if (!push.ok) {
    state.lastError = push.stderr.trim();
    return { ok: false, committed, pushed: false, message, error: push.stderr.trim() };
  }
  state.lastError = null;
  return { ok: true, committed, pushed: true, message, error: null };
}

/** True when a `git push` failed because the remote has commits we don't
 *  (a non-fast-forward / "fetch first" rejection) — the case we recover from
 *  by rebasing onto the remote and retrying. Other failures (auth, network)
 *  are surfaced as-is. */
export function isNonFastForward(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("fetch first") ||
    s.includes("non-fast-forward") ||
    s.includes("[rejected]") ||
    s.includes("! [remote rejected]") ||
    (s.includes("rejected") && s.includes("remote contains work"))
  );
}

/** Get the current status of a repo. */
export async function getRepoStatus(repo: JobsRepoConfig): Promise<RepoStatus> {
  const slug = repoSlug(repo);
  const state = getRepoState(slug);
  const dir = await resolveRepoDir(repo);
  // For plugins, "cloned" = "installed" — there's no .git, but the install
  // dir exists once `claude plugin install` has run.
  const cloned =
    repo.kind === "plugin" ? existsSync(dir) : existsSync(join(dir, ".git"));
  let dirty = false, ahead = 0, behind = 0;
  if (cloned && repo.kind === "git") {
    const st = await runGit(dir, STATUS_ARGS);
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
  const jobs = await countRootMdFiles(dir, cloned);
  return {
    slug,
    kind: repo.kind,
    url: repo.url,
    configured: !!repo.url,
    cloned, dirty, ahead, behind,
    branch: repo.branch,
    dir,
    lastPullAt: state.lastPullAt,
    lastError: state.lastError,
    lastForcedAt: state.lastForcedAt,
    lastDiscarded: state.lastDiscarded,
    plugins,
    jobs,
  };
}

/** Count top-level `.md` files in a source dir — errandd's job-loader
 *  picks routines from here. Returns 0 when the dir isn't present. */
async function countRootMdFiles(dir: string, present: boolean): Promise<number> {
  if (!present) return 0;
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".md")).length;
  } catch {
    return 0;
  }
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
      const slug = repoSlug(repo);
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
    kind: "git",
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
    lastForcedAt: null,
    lastDiscarded: null,
    plugins: [],
    jobs: 0,
  };
}
