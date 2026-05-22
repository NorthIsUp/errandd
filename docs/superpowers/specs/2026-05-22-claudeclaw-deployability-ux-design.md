# ClaudeClaw — Deployability, Git-Backed Jobs & UX Rewrite

**Date:** 2026-05-22
**Status:** Approved design — ready for implementation planning

## Goal

One combined iteration on ClaudeClaw covering six features:

1. All config in a file, overridable by environment variables.
2. A Dockerfile for containerized deployment.
3. A "jobs repo" that is cloned and `git pull`-ed on a configurable interval.
4. A Jobs section in the web UI with a file explorer + code editor.
5. A button to sync local job changes back to git (commit + push).
6. Chat session rename + close, as part of a full-screen, responsive UX rewrite.

The work is split into two parts in this document: **Part 1 — Backend** (UX-agnostic) and **Part 2 — UX rewrite**. Both ship together as one spec.

## Current architecture (relevant pieces)

- **Runtime:** Bun + TypeScript, no bundler. Entry `src/index.ts`.
- **Config:** `src/config.ts` reads `.claude/claudeclaw/settings.json`, `parseSettings()` builds a `Settings` object cached in-process. A few fields already read `process.env` inline (`TELEGRAM_TOKEN`, `DISCORD_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`).
- **Jobs:** `src/jobs.ts` loads `*.md` job files from `getJobsDir()` (default `.claude/claudeclaw/jobs`) and per-agent `agents/<name>/jobs/`. `src/cron.ts` matches schedules.
- **Web UI:** `src/ui/` — `server.ts` (Bun.serve, bearer auth, Host/CSRF checks), `page/{html,styles,script}.ts` (a single hand-written HTML/CSS/JS app served as a string), `services/{jobs,logs,sessions,settings,state,usage}.ts`.
- **UI today:** tabs Dashboard / Chat / Usage; decorative hero (ASCII lobster, typewriter), dock bubbles, Settings + Heartbeat + Advanced-info modals. Chat is a two-pane session-list + chat view.

## Constraints

- Keep the no-bundler approach: the page is served as a string. Splitting `script.ts`/`styles.ts` into modules concatenated at serve time is allowed; introducing a build step is not.
- Do not break existing single-session / daemon behavior.
- All new API routes sit behind the existing bearer-token auth and Host/CSRF checks in `server.ts`.
- `bun test` must pass; new logic gets unit tests.
- Run `bun run bump:plugin-version` and `bun run bump:marketplace-version` before opening the PR (required CI checks).

---

# Part 1 — Backend (UX-agnostic)

## 1.1 Config + `CLAUDECLAW_*` environment overrides

`settings.json` remains the source of truth. Environment variables override individual fields.

**New file: `src/env-overrides.ts`**

- Exports a declarative `ENV_OVERRIDES` table. Each entry:
  ```ts
  interface EnvOverride {
    env: string;            // e.g. "CLAUDECLAW_WEB_PORT"
    path: string[];         // settings path, e.g. ["web", "port"]
    kind: "string" | "number" | "boolean" | "stringList";
    alias?: string;         // back-compat env name, e.g. "DISCORD_TOKEN"
  }
  ```
- Exports `applyEnvOverrides(settings: Settings): Settings` — for each entry, if `process.env[env]` (or `process.env[alias]`) is set and non-empty, parse per `kind` and assign at `path`. `stringList` splits on commas and trims. Invalid numbers/booleans are ignored with a `console.warn`.
- `loadSettings()` and `reloadSettings()` in `config.ts` call `applyEnvOverrides()` after `parseSettings()`.

**Coverage:** every scalar field of `Settings` and simple string-list fields. Examples:
`CLAUDECLAW_MODEL`, `CLAUDECLAW_API`, `CLAUDECLAW_TIMEZONE`, `CLAUDECLAW_WEB_ENABLED`, `CLAUDECLAW_WEB_HOST`, `CLAUDECLAW_WEB_PORT`, `CLAUDECLAW_API_TOKEN`, `CLAUDECLAW_HEARTBEAT_ENABLED`, `CLAUDECLAW_HEARTBEAT_INTERVAL`, `CLAUDECLAW_TELEGRAM_TOKEN` (alias `TELEGRAM_TOKEN`), `CLAUDECLAW_DISCORD_TOKEN` (alias `DISCORD_TOKEN`), `CLAUDECLAW_SLACK_BOT_TOKEN` (alias `SLACK_BOT_TOKEN`), `CLAUDECLAW_SLACK_APP_TOKEN` (alias `SLACK_APP_TOKEN`), `CLAUDECLAW_SECURITY_LEVEL`, `CLAUDECLAW_JOBSREPO_URL`, `CLAUDECLAW_JOBSREPO_BRANCH`, `CLAUDECLAW_JOBSREPO_INTERVAL`.

The existing inline `process.env.X ||` checks in `parseSettings()` are removed — `applyEnvOverrides()` is the single mechanism.

**Out of scope for env override:** nested arrays/objects (`heartbeat.excludeWindows`, `agentic.modes`, `plugins`, `discord.channelNames`). These remain file-only. Documented as such.

**Docs:** new `.env.example` listing every `CLAUDECLAW_*` var with a short comment; README section "Configuration & environment overrides".

## 1.2 Dockerfile

**New files: `./Dockerfile`, `./.dockerignore`.**

Modeled on `teamclara/infrastructure/images/claudeclaw/Dockerfile`:

- Base `debian:trixie-slim`; install `ca-certificates curl git gnupg ripgrep jq unzip less openssl nodejs` (Node 22 via NodeSource) and `gh` (GitHub apt repo).
- Create non-root user `claude`; install `@anthropic-ai/claude-code` globally (npm, no sudo) and `bun` (official installer).
- `WORKDIR /app`; `COPY package.json bun.lock ./` then `bun install --frozen-lockfile`; `COPY . .`.
- Default env: `CLAUDECLAW_WEB_ENABLED=true`, `CLAUDECLAW_WEB_HOST=0.0.0.0`, `CLAUDECLAW_WEB_PORT=4632`.
- `EXPOSE 4632`; `VOLUME ["/app/.claude"]` for persistent state.
- `ENTRYPOINT ["bun", "run", "src/index.ts"]`; `CMD ["start", "--web"]`.

`.dockerignore`: `node_modules`, `.git`, `.claude`, `images`, `docs`, `*.md` (except as needed), test artifacts.

Claude credentials are supplied at runtime via a mounted `.claude` volume or `CLAUDE_CODE_OAUTH_TOKEN`; the Dockerfile documents this but does not orchestrate token minting (that stays in the infra layer). README gets a "Run with Docker" section.

## 1.3 `jobsRepo` config + periodic pull

**Config change (`src/config.ts`):**

```ts
interface JobsRepoConfig {
  url: string;             // git remote; "" = feature disabled
  branch: string;          // default "main"
  intervalSeconds: number; // default 300; 0 disables periodic pull
}
```

Added to `Settings` as `jobsRepo`, to `DEFAULT_SETTINGS` as `{ url: "", branch: "main", intervalSeconds: 300 }`, and parsed in `parseSettings()`.

**`getJobsDir()` change:** when `jobsRepo.url` is set, return the clone dir (`.claude/claudeclaw/jobs-repo`). Precedence: explicit `jobsDir` setting > jobs-repo clone dir (when `jobsRepo` configured) > default `.claude/claudeclaw/jobs`. The repo *is* the jobs dir — UI-created `quick-*` jobs write into it too.

**New file: `src/jobsRepo.ts`** — all functions shell out to `git` via `Bun.spawn`/`execFile`-style calls:

- `getJobsRepoDir(): string` → `.claude/claudeclaw/jobs-repo`.
- `ensureJobsRepo(): Promise<void>` — if `jobsRepo.url` set and the dir has no `.git`, `git clone --branch <branch> <url> <dir>`. The dir may be pre-created empty by `initConfig()`; clone into an empty dir is fine. On failure: log and continue (jobs fall back to whatever is on disk).
- `pullJobsRepo(): Promise<JobsRepoStatus>` — if the working tree is clean: `git fetch origin <branch>` then `git merge --ff-only origin/<branch>`. If the tree is **dirty**, skip the pull entirely and set `dirty: true`. Never destructive.
- `getJobsRepoStatus(): Promise<JobsRepoStatus>` — `{ configured, cloned, dirty, ahead, behind, branch, lastPullAt, lastError }`. `dirty` from `git status --porcelain`; `ahead`/`behind` from `git rev-list --count`.
- `syncJobsRepo(): Promise<SyncResult>` — `git add -A`; if nothing staged, return `{ committed: false }`; else `git commit -m "claudeclaw: sync jobs (<ISO timestamp>)"` then `git push origin <branch>`. Returns `{ committed, pushed, message, error? }`. Uses ambient git credentials (SSH key / `gh auth setup-git`); ClaudeClaw does not manage credentials.

**Daemon wiring (`src/index.ts` start path):** after `initConfig()`, call `ensureJobsRepo()`; then register a `setInterval` that calls `pullJobsRepo()` every `jobsRepo.intervalSeconds` (skipped when `0` or `url` empty). Existing job hot-reload picks up pulled files on the next scheduler tick.

`initConfig()` ordering: `mkdir(getJobsDir())` runs before `ensureJobsRepo()`; cloning into the empty dir works.

## 1.4 Jobs file-service

**`src/ui/services/jobs.ts` additions** — all scoped to `getJobsDir()` with strict path-traversal protection:

- `listJobFiles(): Promise<JobFile[]>` — recursive list, relative paths, `{ path, name, size, mtime, isJob }` (`isJob` = ends `.md` with valid frontmatter).
- `readJobFile(relPath): Promise<string>`.
- `writeJobFile(relPath, content): Promise<void>`.
- `createJobFile(relPath): Promise<void>` — fails if exists.
- `deleteJobFile(relPath): Promise<void>`.

**Path guard:** `relPath` must match `^[A-Za-z0-9._/-]+$`, contain no `..` segment, and `resolve(jobsDir, relPath)` must stay within `jobsDir` (checked via `realpath`/prefix). Reject otherwise.

## 1.5 Session metadata (rename + close)

**New file: `src/ui/services/session-meta.ts`** — manages `.claude/claudeclaw/session-meta.json`:

```ts
interface SessionMetaStore { sessions: Record<string, { title?: string; closed?: boolean }>; }
```

- `getSessionMeta()`, `setSessionTitle(id, title)`, `setSessionClosed(id, closed)`. Title trimmed, max 120 chars.

**`listSessions()` change (`src/ui/services/sessions.ts`):** merge meta in — `SessionInfo` gains `title?: string` and `closed: boolean`. The function accepts `includeClosed = false`; by default closed sessions are filtered out.

## 1.6 New API routes (`src/ui/server.ts`)

All behind existing bearer auth + Host/CSRF checks.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/home` | Aggregator: recent logs, upcoming jobs, jobs-repo status, server status, usage |
| GET | `/api/jobs/files` | List job files |
| GET | `/api/jobs/file?path=` | Read one file |
| PUT | `/api/jobs/file` | Save `{ path, content }` |
| POST | `/api/jobs/file` | Create `{ path }` |
| DELETE | `/api/jobs/file?path=` | Delete |
| GET | `/api/jobs/repo/status` | `getJobsRepoStatus()` |
| POST | `/api/jobs/repo/sync` | `syncJobsRepo()` |
| POST | `/api/jobs/repo/pull` | Manual `pullJobsRepo()` |
| GET | `/api/sessions?includeClosed=1` | List sessions (closed included when flag set) |
| PUT | `/api/sessions/<id>/title` | Set `{ title }` |
| POST | `/api/sessions/<id>/close` | Mark closed |
| POST | `/api/sessions/<id>/reopen` | Mark reopened |

Session-id route params validated against the existing UUID regex.

---

# Part 2 — UX rewrite (full-screen responsive app)

Rewrites `src/ui/page/{html,styles,script}.ts`. The decorative hero (ASCII lobster, typewriter), dock bubbles, and the Settings/Heartbeat/Advanced modals are removed. `script.ts` and `styles.ts` are split into per-section source modules concatenated at serve time (no bundler): `shell`, `home`, `chats`, `jobs`, `settings`.

## 2.1 Shell & navigation

- **Desktop:** slim left icon rail with a small 🦞 mark at the top and four entries — **Home · Chats · Jobs · Settings**. The active section fills the rest of the viewport.
- **Mobile:** the rail collapses behind a hamburger button (top-left); tapping it slides out a drawer with the same entries; selecting one closes the drawer.
- Breakpoint-driven via CSS media queries; no JS framework.
- Section switching is client-side (show/hide panels), same pattern as today's `setActiveTab`.

## 2.2 Home

Card grid (CSS grid, reflows to one column on mobile). One round-trip to `/api/home`:

- **Recent actions** — recent run/heartbeat/job log entries (from the logs service).
- **Upcoming actions** — next N scheduled jobs with their next run time (`loadJobs()` + `nextCronMatch()`).
- **Git sync status** — `jobsRepo` status: configured/cloned, clean vs dirty, ahead/behind, last pull. A "Sync now" affordance links to the Jobs section.
- **Server status** — daemon up/uptime, web host/port, model (from existing state service).
- **Usage** — token consumption / estimated cost per session (existing usage service).

## 2.3 Chats

Two-pane: session list (left) + interactive chat (right). On mobile, single-column — the list is shown first; selecting a session swaps to the chat with a back button.

- Session rows show `title` when set, else the message-preview fallback. Each row has a rename control (✎ — inline text input, commits via `PUT /api/sessions/<id>/title`) and a close control (× — `POST /api/sessions/<id>/close`, row disappears).
- List header has a "Show closed (N)" toggle that re-fetches with `?includeClosed=1`; closed rows render with a reopen control.
- Existing chat behavior (send, attachments, streaming, history paging, new session) is preserved — only the surrounding layout and the per-row controls change.

## 2.4 Jobs

Two-pane: job file list (left) + editor (right). On mobile, single-column with back navigation.

- Editor is a monospace `<textarea spellcheck="false">` — no Monaco/CodeMirror (consistent with the no-bundler UI). Tab key inserts spaces; unsaved-changes indicator.
- Buttons: `+ New`, `Delete`, `Save`, `Sync to Git`.
- A repo-status line shows clean/dirty + last pull (from `/api/jobs/repo/status`); after a save it refreshes.
- `Sync to Git` calls `POST /api/jobs/repo/sync`; on success refreshes status (dirty → clean), on failure shows the git error. Disabled with an explanatory tooltip when `jobsRepo` is not configured.

## 2.5 Settings

A full section (replaces today's modals): model, fallback model, heartbeat config (enabled/interval/prompt), security level, clock format, and the new `jobsRepo` config (url / branch / interval). Reuses the existing settings read/update service; adds `jobsRepo` fields.

---

## Testing

`bun test` additions:

- **env-overrides:** each `kind` parses correctly; aliases honored; env beats file; invalid values ignored.
- **jobsRepo:** status parsing from `git` output; dirty detection skips pull; `syncJobsRepo()` command sequence and "nothing to commit" path — exercised against a temp git repo fixture.
- **jobs file-service:** path-traversal attempts rejected; list/read/write/create/delete within a temp dir.
- **session-meta:** title set/get (trim, length cap); `closed` filtering in `listSessions()`.

## Build order

1. Config + `CLAUDECLAW_*` env overrides
2. `jobsRepo` module + periodic pull wiring
3. Git-sync (`syncJobsRepo`)
4. Jobs file-service + session-meta + new API routes
5. UX shell (rail/hamburger nav)
6. Home section
7. Chats section (rename/close)
8. Jobs section (editor + sync)
9. Settings section
10. Dockerfile + `.dockerignore` + docs

## Out of scope

- Build-step / bundler for the web UI.
- Credential management for git or Claude auth (ambient credentials only).
- Env overrides for nested array/object config.
- Syntax-highlighted code editor (plain textarea only).
