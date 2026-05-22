# Multiple Jobs / Plugin Repos

**Date:** 2026-05-22
**Status:** Approved design — ready for implementation
**Branch:** continues on `feat/deployability-jobs-ux` (same PR)

## Goal

Replace the single `jobsRepo` with a **list** of jobs/plugin repos. Each repo is independently cloned, pulled, and synced; jobs and Claude-plugin skills/commands aggregate across all of them. The Settings section is renamed **"Jobs Plugin Repos"**, lets you add/remove repos with a `+` / `−`, and decorates each entry with an icon when it contributes a discovered plugin.

## Background

Today `settings.jobsRepo: { url, branch, intervalSeconds }` is single. `getJobsDir()` returns one path — the clone of that repo. `ensureJobsRepo` / `pullJobsRepo` / `syncJobsRepo` / `getJobsRepoStatus` all operate on one. The Settings UI exposes one set of fields. `loadJobs` reads one directory. Plugin discovery (`discoverJobsRepoPlugins`) scans one clone.

The user wants N repos and a discoverable "this one provides plugins" affordance.

## Design

### 1. Config — `src/config.ts`

Introduce `jobsRepos: JobsRepoConfig[]`. Keep `jobsRepo: JobsRepoConfig` as legacy back-compat:

```ts
export interface JobsRepoConfig { url: string; branch: string; intervalSeconds: number; }
export interface Settings {
  /* … */
  /** @deprecated single-repo form; migrated into `jobsRepos[0]` at load. */
  jobsRepo: JobsRepoConfig;
  jobsRepos: JobsRepoConfig[];
}
```

In `parseSettings()`, after parsing both, merge with this precedence:
- `jobsRepos` (array) wins if non-empty.
- Otherwise, if legacy `jobsRepo.url` is set, lift it into `jobsRepos = [jobsRepo]`.
- Otherwise `jobsRepos = []`.
The cached `Settings` always exposes the array. Existing inline reads of `cached.jobsRepo.url` switch to `cached.jobsRepos[0]?.url` (a tiny helper `firstJobsRepo()` is fine).

Env overrides:
- `CLAUDECLAW_JOBSREPO_URL` / `_BRANCH` / `_INTERVAL` continue to set the FIRST repo (back-compat shortcut for single-repo Docker deployments).
- Add `CLAUDECLAW_JOBSREPOS` — a comma-separated list of git URLs that REPLACES the file's list when set. Each entry uses defaults `branch="main"`, `intervalSeconds=300`. (Mixed-config env knobs aren't worth the complexity; if you need fine-grained env config for N repos, edit the file.)

### 2. Per-repo clone directory — `src/jobsRepo.ts`

Each repo gets its own clone dir under `.claude/claudeclaw/jobs-repos/<slug>/`. Slug derivation: `slugForRepo(url)`:
- strip a trailing `.git`,
- take the last path segment (after the last `/`),
- lowercase, replace any non-`[a-z0-9-]` with `-`, collapse runs of `-`.
- if the result is empty or collides with an existing slug, append a short hash (`sha256(url).slice(0,8)`).

Add `getJobsRepoDir(repo: JobsRepoConfig | string): string` returning `.claude/claudeclaw/jobs-repos/<slug>`. (Keep the old `getJobsRepoDir()` no-arg form returning the legacy single path for the migration window — or just remove it; the call sites all live in `jobsRepo.ts` and the spawn-args module.)

### 3. `getJobsDir` → `getJobsDirs` — `src/config.ts`

Add `export function getJobsDirs(): string[]`:
- if any `jobsRepos[*].url` is set, return every clone dir (in config order) PLUS the default `.claude/claudeclaw/jobs` dir for UI-created local-only jobs (the default dir is appended last so repos take precedence visually).
- else return `[DEFAULT_JOBS_DIR]`.

Keep `getJobsDir(): string` as `getJobsDirs()[0]` for any single-dir caller that genuinely only needs one (write paths still pick an explicit dir — see §6).

### 4. Per-repo lifecycle — `src/jobsRepo.ts`

Generalize every operation to take a `repo: JobsRepoConfig`:
- `ensureRepo(repo)` — clone if missing.
- `pullRepo(repo)` — same dirty-skip ff-only pull.
- `syncRepo(repo)` — same add/commit/push.
- `getRepoStatus(repo): RepoStatus` — `{ url, branch, dir, slug, configured, cloned, dirty, ahead, behind, lastPullAt, lastError, plugins: JobsRepoPlugin[] }`.

Top-level helpers iterate:
- `ensureAllRepos()` — `Promise.all(repos.map(ensureRepo))`.
- `pullAllRepos()` — fires per-repo pulls (errors logged per-repo, never throw).
- `getAllRepoStatuses(): Promise<RepoStatus[]>`.
- The existing `JobsRepoStatus` type becomes the **per-repo** shape (rename to `RepoStatus`); the old shape's call sites move to the array form.

Daemon wiring (`src/commands/start.ts`): one `setInterval` per repo gated on its own `intervalSeconds`.

### 5. Plugin discovery + spawn args — `src/jobsRepoPlugins.ts`

`discoverJobsRepoPlugins()` becomes `discoverPlugins(): Promise<JobsRepoPlugin[]>` and scans **every** repo's clone dir (root, immediate subdirs, `plugins/*`), concatenating results. `getJobsRepoSpawnArgs()` emits one `--plugin-dir` per discovered plugin across all repos (or `--add-dir` per repo that ships skills without a manifest). `runner.ts` doesn't change — it already spreads whatever the helper returns.

### 6. Job file-service + writes — `src/ui/services/jobs.ts`

`listJobFiles()` already accepts an explicit `dir`. Add `listAllJobFiles(): Promise<{ repo: { slug, label }, files: JobFileEntry[] }[]>` that calls `listJobFiles(dir)` for each repo dir + default local dir, returns a grouped list. (Or a flat list with each entry tagged `repoSlug`; the UI groups visually.)

Writes (`writeJobFile`, `createJobFile`, `deleteJobFile`, `renameJobFile`) require an explicit `dir`. The UI/API caller decides which repo. Default for `+ New` when only one repo is configured: that repo. When multiple: the UI prompts/picks (see §8).

### 7. API — `src/ui/server.ts`

Routes generalize to per-repo:
- `GET /api/jobs/repos` → array of `RepoStatus`. (Replaces `/api/jobs/repo/status`; keep `/api/jobs/repo/status` as an alias returning the first repo for back-compat.)
- `POST /api/jobs/repos/<slug>/pull` and `/sync` — operate on one repo by slug.
- `GET /api/jobs/files?repo=<slug>` and `POST/PUT/DELETE /api/jobs/file?repo=<slug>&path=…` — the repo param identifies the target dir. When `repo` is omitted, default to the first repo (back-compat).
- `/api/home` returns `repos: RepoStatus[]` instead of `repo: …`.
- `PUT /api/settings` whitelist gains `jobsRepos` (an array).

### 8. UI

**Settings → "Jobs Plugin Repos"** (`sections/settings.ts`, `script.ts`):
- Section title renamed; the existing single-repo block becomes a repeating list, one block per repo (`#jobs-repos-list`) with editable `url`, `branch`, `intervalSeconds` (seconds), and a `−` (remove) button.
- A `+ Add` button appends an empty new row (focus the url field).
- Beside each row's label, when its `RepoStatus.plugins` is non-empty, show a 🧩 icon with a tooltip "provides N plugin(s)" — visually marks the repo as a plugin source. Repos without plugins show nothing (or a muted dash).
- Save Changes PUTs `jobsRepos` (array) to `/api/settings`; rows with empty URLs are dropped.

**Jobs section** (`sections/jobs.ts`, `script.ts`):
- File list groups by repo (slug shown as a small heading; default local files under "Local").
- `+ New`: when `repos.length <= 1`, defaults to that repo (or the local dir if no repos). When multiple, opens a tiny chooser (a `<select>` of repo slugs) before the file is created. The Haiku rename flow stays in-repo.
- Per-repo `Sync to Git` button. Per-repo status line (clean/dirty, last pull, plugins-N).

**Home git-sync card**: lists each repo's status compactly (slug + clean/dirty + plugins-N), instead of one repo.

### 9. Migration / first run

The settings.json on disk usually has the legacy `jobsRepo`. The first `reloadSettings()` after this change reads `jobsRepo` and exposes it as `jobsRepos[0]` in memory; the file is **not** rewritten until the user clicks Save in Settings (which now writes `jobsRepos`). No data loss; the legacy field stays in the JSON until overwritten.

### 10. Out of scope

- Per-repo authentication / credentials — ambient git creds as today.
- Conflict resolution UI when two repos provide overlapping plugin names (last-loaded wins; Claude Code namespacing handles most cases).
- Per-repo `reuse_session` defaults.
- A "marketplace" / discovery UI for adding popular repos.

## Testing

- `parseSettings`: legacy `jobsRepo` migrates to `jobsRepos[0]`; explicit `jobsRepos: [...]` wins; both empty → empty array.
- `slugForRepo` against the obvious URL forms (https/ssh, with/without `.git`, capitalization) — including the collision-hash fallback when two URLs collapse to the same slug.
- `getJobsDirs` returns the right list in the four cases (none / single legacy / single new / multiple).
- Plugin discovery across two test repos: each contributing one plugin → spawn args contain `--plugin-dir <repo1>` AND `--plugin-dir <repo2>`.
- `pullAllRepos` against two temp repos (one clean, one dirty) — clean pulls, dirty skipped, no cross-effect.

## Build order (for the implementation plan)

1. Config: `jobsRepos` + migration + `getJobsDirs` + `firstJobsRepo` helper. Update `parseSettings` and env-overrides.
2. `jobsRepo.ts`: per-repo helpers + `slugForRepo` + `getJobsRepoDir(repo)` + `ensureAllRepos`/`pullAllRepos`/`getAllRepoStatuses`.
3. Plugin discovery scans all repos; spawn args aggregate.
4. Daemon wiring: per-repo intervals.
5. API routes: `/api/jobs/repos`, per-repo file routes with `?repo=`, settings whitelist `jobsRepos`.
6. UI: Settings list with `+`/`−` + plugin icon; Jobs section repo-grouped file list + per-repo sync/status; Home compact repo list.
7. Tests across the boundaries listed above.
