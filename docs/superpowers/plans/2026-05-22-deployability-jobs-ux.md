# ClaudeClaw Deployability, Git-Backed Jobs & UX Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ClaudeClaw deployable (env-overridable config + Dockerfile), back its jobs with a periodically-pulled git repo plus a UI editor and git-sync, and rewrite the web UI as a full-screen responsive 4-section app.

**Architecture:** Backend changes are UX-agnostic: a declarative env-override layer over `settings.json`, a `jobsRepo` git module, a job file-service and session-meta store, all exposed via new authenticated API routes. The web UI (`src/ui/page/`) is rewritten as a rail/hamburger-navigated app (Home/Chats/Jobs/Settings) consuming those APIs. No bundler is introduced — the page is still served as a concatenated string.

**Tech Stack:** Bun, TypeScript, `bun test`, `git` CLI via subprocess, hand-written HTML/CSS/JS.

**Spec:** `docs/superpowers/specs/2026-05-22-claudeclaw-deployability-ux-design.md`

---

## File Structure

**Create:**
- `src/env-overrides.ts` — `ENV_OVERRIDES` table + `applyEnvOverrides()`
- `src/jobsRepo.ts` — clone/pull/status/sync git operations for the jobs repo
- `src/ui/services/session-meta.ts` — `session-meta.json` title/closed store
- `src/__tests__/env-overrides.test.ts`, `src/__tests__/jobsRepo.test.ts`, `src/__tests__/jobs-fileservice.test.ts`, `src/__tests__/session-meta.test.ts`
- `Dockerfile`, `.dockerignore`, `.env.example`
- `src/ui/page/sections/` — `shell.ts`, `home.ts`, `chats.ts`, `jobs.ts`, `settings.ts` (per-section markup+script fragments)

**Modify:**
- `src/config.ts` — `JobsRepoConfig`, `getJobsDir()` precedence, call `applyEnvOverrides()`
- `src/ui/services/jobs.ts` — file-service functions
- `src/ui/services/sessions.ts` — merge session-meta, `includeClosed` param
- `src/ui/server.ts` — new routes
- `src/commands/start.ts` — `ensureJobsRepo()` + periodic pull interval
- `src/ui/page/{html,styles,script}.ts` — UX rewrite
- `README.md` — Docker + config docs

---

## Task 1: `CLAUDECLAW_*` environment overrides

**Files:**
- Create: `src/env-overrides.ts`
- Create: `src/__tests__/env-overrides.test.ts`
- Modify: `src/config.ts`

- [ ] **Step 1: Write failing tests**

`src/__tests__/env-overrides.test.ts`:
```ts
import { test, expect, afterEach } from "bun:test";
import { applyEnvOverrides } from "../env-overrides";
import type { Settings } from "../config";

function base(): Settings {
  return JSON.parse(JSON.stringify({
    model: "", api: "", fallback: { model: "", api: "" },
    agentic: { enabled: false, defaultMode: "implementation", modes: [] },
    timezone: "UTC", timezoneOffsetMinutes: 0,
    heartbeat: { enabled: false, interval: 15, prompt: "", excludeWindows: [], forwardToTelegram: true },
    telegram: { token: "", allowedUserIds: [], listenChats: [], receiveEnabled: true, dmIsolation: "shared" },
    discord: { token: "", allowedUserIds: [], listenChannels: [], listenGuilds: [], allowedGuilds: [], imageOutputRoots: [], streaming: false },
    slack: { botToken: "", appToken: "", allowedUserIds: [], listenChannels: [], allowBots: [], allowBotIds: [] },
    security: { level: "moderate", allowedTools: [], disallowedTools: [] },
    web: { enabled: false, host: "127.0.0.1", port: 4632 },
    stt: { baseUrl: "", model: "" },
    sessionTimeoutMs: 1, timeouts: { telegram: 5, heartbeat: 15, job: 30, default: 5 },
    watchdog: { maxConsecutiveTimeouts: null, maxRuntimeSeconds: null },
    session: { autoRotate: false, maxMessages: 50, maxAgeHours: 24, summaryPath: "" },
    plugins: {}, jobsRepo: { url: "", branch: "main", intervalSeconds: 300 },
  })) as Settings;
}

const touched: string[] = [];
function setEnv(k: string, v: string) { touched.push(k); process.env[k] = v; }
afterEach(() => { for (const k of touched) delete process.env[k]; touched.length = 0; });

test("string override applies", () => {
  setEnv("CLAUDECLAW_MODEL", "opus");
  expect(applyEnvOverrides(base()).model).toBe("opus");
});

test("number override parses", () => {
  setEnv("CLAUDECLAW_WEB_PORT", "8080");
  expect(applyEnvOverrides(base()).web.port).toBe(8080);
});

test("boolean override parses true/false", () => {
  setEnv("CLAUDECLAW_WEB_ENABLED", "true");
  expect(applyEnvOverrides(base()).web.enabled).toBe(true);
});

test("invalid number is ignored", () => {
  setEnv("CLAUDECLAW_WEB_PORT", "not-a-number");
  expect(applyEnvOverrides(base()).web.port).toBe(4632);
});

test("alias env var is honored", () => {
  setEnv("DISCORD_TOKEN", "abc");
  expect(applyEnvOverrides(base()).discord.token).toBe("abc");
});

test("primary name wins over alias", () => {
  setEnv("DISCORD_TOKEN", "alias");
  setEnv("CLAUDECLAW_DISCORD_TOKEN", "primary");
  expect(applyEnvOverrides(base()).discord.token).toBe("primary");
});

test("jobsRepo fields override", () => {
  setEnv("CLAUDECLAW_JOBSREPO_URL", "git@example.com:x.git");
  setEnv("CLAUDECLAW_JOBSREPO_INTERVAL", "600");
  const s = applyEnvOverrides(base());
  expect(s.jobsRepo.url).toBe("git@example.com:x.git");
  expect(s.jobsRepo.intervalSeconds).toBe(600);
});

test("unset env leaves settings untouched", () => {
  expect(applyEnvOverrides(base()).model).toBe("");
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test src/__tests__/env-overrides.test.ts`
Expected: FAIL — `Cannot find module '../env-overrides'`.

- [ ] **Step 3: Implement `src/env-overrides.ts`**

```ts
import type { Settings } from "./config";

type Kind = "string" | "number" | "boolean" | "stringList";

interface EnvOverride {
  env: string;
  path: string[];
  kind: Kind;
  alias?: string;
}

export const ENV_OVERRIDES: EnvOverride[] = [
  { env: "CLAUDECLAW_MODEL", path: ["model"], kind: "string" },
  { env: "CLAUDECLAW_API", path: ["api"], kind: "string" },
  { env: "CLAUDECLAW_FALLBACK_MODEL", path: ["fallback", "model"], kind: "string" },
  { env: "CLAUDECLAW_FALLBACK_API", path: ["fallback", "api"], kind: "string" },
  { env: "CLAUDECLAW_TIMEZONE", path: ["timezone"], kind: "string" },
  { env: "CLAUDECLAW_API_TOKEN", path: ["apiToken"], kind: "string" },
  { env: "CLAUDECLAW_WEB_ENABLED", path: ["web", "enabled"], kind: "boolean" },
  { env: "CLAUDECLAW_WEB_HOST", path: ["web", "host"], kind: "string" },
  { env: "CLAUDECLAW_WEB_PORT", path: ["web", "port"], kind: "number" },
  { env: "CLAUDECLAW_HEARTBEAT_ENABLED", path: ["heartbeat", "enabled"], kind: "boolean" },
  { env: "CLAUDECLAW_HEARTBEAT_INTERVAL", path: ["heartbeat", "interval"], kind: "number" },
  { env: "CLAUDECLAW_SECURITY_LEVEL", path: ["security", "level"], kind: "string" },
  { env: "CLAUDECLAW_TELEGRAM_TOKEN", path: ["telegram", "token"], kind: "string", alias: "TELEGRAM_TOKEN" },
  { env: "CLAUDECLAW_DISCORD_TOKEN", path: ["discord", "token"], kind: "string", alias: "DISCORD_TOKEN" },
  { env: "CLAUDECLAW_SLACK_BOT_TOKEN", path: ["slack", "botToken"], kind: "string", alias: "SLACK_BOT_TOKEN" },
  { env: "CLAUDECLAW_SLACK_APP_TOKEN", path: ["slack", "appToken"], kind: "string", alias: "SLACK_APP_TOKEN" },
  { env: "CLAUDECLAW_STT_BASE_URL", path: ["stt", "baseUrl"], kind: "string" },
  { env: "CLAUDECLAW_STT_MODEL", path: ["stt", "model"], kind: "string" },
  { env: "CLAUDECLAW_JOBSREPO_URL", path: ["jobsRepo", "url"], kind: "string" },
  { env: "CLAUDECLAW_JOBSREPO_BRANCH", path: ["jobsRepo", "branch"], kind: "string" },
  { env: "CLAUDECLAW_JOBSREPO_INTERVAL", path: ["jobsRepo", "intervalSeconds"], kind: "number" },
];

function coerce(kind: Kind, raw: string): string | number | boolean | string[] | undefined {
  if (kind === "string") return raw;
  if (kind === "stringList") return raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (kind === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (kind === "boolean") {
    const v = raw.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(v)) return true;
    if (["false", "0", "no", "off"].includes(v)) return false;
    return undefined;
  }
  return undefined;
}

function assignPath(obj: Record<string, any>, path: string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (typeof cur[path[i]] !== "object" || cur[path[i]] === null) cur[path[i]] = {};
    cur = cur[path[i]];
  }
  cur[path[path.length - 1]] = value;
}

/** Apply CLAUDECLAW_* (and back-compat alias) environment variables on top of file settings. */
export function applyEnvOverrides(settings: Settings): Settings {
  for (const o of ENV_OVERRIDES) {
    const raw = process.env[o.env] ?? (o.alias ? process.env[o.alias] : undefined);
    if (raw == null || raw.trim() === "") continue;
    const value = coerce(o.kind, raw);
    if (value === undefined) {
      console.warn(`[config] Ignoring ${o.env}: invalid ${o.kind} value "${raw}"`);
      continue;
    }
    assignPath(settings as unknown as Record<string, any>, o.path, value);
  }
  return settings;
}
```

- [ ] **Step 4: Wire into `config.ts`**

In `src/config.ts`: add `import { applyEnvOverrides } from "./env-overrides";`. Add `jobsRepo` to `Settings`, `DEFAULT_SETTINGS`, and `parseSettings()` (see Task 2 — do the `JobsRepoConfig` part now so the type exists). Remove the inline `process.env.TELEGRAM_TOKEN?.trim() || ...`, `process.env.DISCORD_TOKEN`, `process.env.SLACK_BOT_TOKEN`, `process.env.SLACK_APP_TOKEN` expressions in `parseSettings()` (replace with the plain `raw....` fallbacks). In both `loadSettings()` and `reloadSettings()`, change the cache assignment to:
```ts
cached = applyEnvOverrides(parseSettings(raw, extractDiscordUserIds(rawText)));
```

- [ ] **Step 5: Run tests, verify pass**

Run: `bun test src/__tests__/env-overrides.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src/env-overrides.ts src/__tests__/env-overrides.test.ts src/config.ts
git commit -m "feat(config): CLAUDECLAW_* environment variable overrides"
```

---

## Task 2: `jobsRepo` config + `getJobsDir()` precedence

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add the `JobsRepoConfig` interface**

In `src/config.ts` near the other config interfaces:
```ts
export interface JobsRepoConfig {
  /** Git remote URL; empty string disables the jobs-repo feature. */
  url: string;
  /** Branch to track. Default "main". */
  branch: string;
  /** Seconds between automatic pulls. Default 300; 0 disables periodic pull. */
  intervalSeconds: number;
}
```
Add `jobsRepo: JobsRepoConfig;` to the `Settings` interface.

- [ ] **Step 2: Add the default**

In `DEFAULT_SETTINGS`, add: `jobsRepo: { url: "", branch: "main", intervalSeconds: 300 },`.

- [ ] **Step 3: Parse it**

In `parseSettings()`, before the closing return object, add:
```ts
    jobsRepo: {
      url: typeof raw.jobsRepo?.url === "string" ? raw.jobsRepo.url.trim() : "",
      branch: typeof raw.jobsRepo?.branch === "string" && raw.jobsRepo.branch.trim()
        ? raw.jobsRepo.branch.trim() : "main",
      intervalSeconds: Number.isFinite(raw.jobsRepo?.intervalSeconds) && Number(raw.jobsRepo.intervalSeconds) >= 0
        ? Number(raw.jobsRepo.intervalSeconds) : 300,
    },
```

- [ ] **Step 4: Add the jobs-repo clone dir constant + change `getJobsDir()`**

Add near the other dir constants: `const JOBS_REPO_DIR = join(HEARTBEAT_DIR, "jobs-repo");`
Add an exported helper:
```ts
/** Directory the jobs git repo is cloned into. */
export function getJobsRepoDir(): string {
  return JOBS_REPO_DIR;
}
```
Change `getJobsDir()` so that, when `jobsRepo.url` is set and no explicit `jobsDir` override is present, it returns `JOBS_REPO_DIR`:
```ts
export function getJobsDir(): string {
  if (cached?.jobsDir) {
    return isAbsolute(cached.jobsDir) ? cached.jobsDir : join(process.cwd(), cached.jobsDir);
  }
  if (cached?.jobsRepo?.url) return JOBS_REPO_DIR;
  return DEFAULT_JOBS_DIR;
}
```

- [ ] **Step 5: Type-check**

Run: `bunx tsc --noEmit` (or `bun build src/index.ts --target bun > /dev/null`)
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts
git commit -m "feat(config): jobsRepo config section and getJobsDir() precedence"
```

---

## Task 3: `jobsRepo.ts` — clone, pull, status

**Files:**
- Create: `src/jobsRepo.ts`
- Create: `src/__tests__/jobsRepo.test.ts`

- [ ] **Step 1: Write failing tests** (use a real temp git repo as the "remote")

`src/__tests__/jobsRepo.test.ts`:
```ts
import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runGit, parseStatus } from "../jobsRepo";

async function tmp(): Promise<string> { return mkdtemp(join(tmpdir(), "ccjr-")); }

test("runGit reports failure for a bad command", async () => {
  const dir = await tmp();
  const res = await runGit(dir, ["status"]); // not a repo
  expect(res.ok).toBe(false);
  await rm(dir, { recursive: true, force: true });
});

test("parseStatus detects clean vs dirty", () => {
  expect(parseStatus("").dirty).toBe(false);
  expect(parseStatus(" M jobs/a.md\n").dirty).toBe(true);
});

test("clone + clean status round-trips", async () => {
  const remote = await tmp();
  await runGit(remote, ["init", "--bare"]);
  const work = await tmp();
  await runGit(work, ["init"]);
  await runGit(work, ["config", "user.email", "t@t"]);
  await runGit(work, ["config", "user.name", "t"]);
  await writeFile(join(work, "a.md"), "---\nschedule: \"0 9 * * *\"\n---\nhi\n");
  await runGit(work, ["add", "-A"]);
  await runGit(work, ["commit", "-m", "init"]);
  await runGit(work, ["branch", "-M", "main"]);
  await runGit(work, ["remote", "add", "origin", remote]);
  await runGit(work, ["push", "-u", "origin", "main"]);

  const clone = await tmp();
  await rm(clone, { recursive: true, force: true });
  const c = await runGit(process.cwd(), ["clone", "--branch", "main", remote, clone]);
  expect(c.ok).toBe(true);
  const st = await runGit(clone, ["status", "--porcelain"]);
  expect(parseStatus(st.stdout).dirty).toBe(false);

  for (const d of [remote, work, clone]) await rm(d, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test src/__tests__/jobsRepo.test.ts`
Expected: FAIL — `Cannot find module '../jobsRepo'`.

- [ ] **Step 3: Implement `src/jobsRepo.ts`**

```ts
import { existsSync } from "fs";
import { join } from "path";
import { getSettings, getJobsRepoDir } from "./config";

export interface GitResult { ok: boolean; stdout: string; stderr: string; code: number; }

export interface JobsRepoStatus {
  configured: boolean;
  cloned: boolean;
  dirty: boolean;
  ahead: number;
  behind: number;
  branch: string;
  lastPullAt: string | null;
  lastError: string | null;
}

export interface SyncResult {
  ok: boolean;
  committed: boolean;
  pushed: boolean;
  message: string;
  error: string | null;
}

let lastPullAt: string | null = null;
let lastError: string | null = null;

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

function repoDir(): string { return getJobsRepoDir(); }
function isCloned(): boolean { return existsSync(join(repoDir(), ".git")); }

/** Clone the jobs repo if configured and not yet present. */
export async function ensureJobsRepo(): Promise<void> {
  const { jobsRepo } = getSettings();
  if (!jobsRepo.url) return;
  if (isCloned()) return;
  const res = await runGit(process.cwd(), [
    "clone", "--branch", jobsRepo.branch, jobsRepo.url, repoDir(),
  ]);
  if (!res.ok) {
    lastError = `clone failed: ${res.stderr.trim()}`;
    console.warn(`[jobsRepo] ${lastError}`);
  } else {
    console.log(`[jobsRepo] cloned ${jobsRepo.url} (${jobsRepo.branch})`);
  }
}

/** Fast-forward pull — only when the working tree is clean. */
export async function pullJobsRepo(): Promise<JobsRepoStatus> {
  const { jobsRepo } = getSettings();
  if (!jobsRepo.url || !isCloned()) return getJobsRepoStatus();
  const st = await runGit(repoDir(), ["status", "--porcelain"]);
  if (parseStatus(st.stdout).dirty) {
    lastError = "local job edits not synced — pull skipped";
    return getJobsRepoStatus();
  }
  const fetched = await runGit(repoDir(), ["fetch", "origin", jobsRepo.branch]);
  if (!fetched.ok) {
    lastError = `fetch failed: ${fetched.stderr.trim()}`;
    return getJobsRepoStatus();
  }
  const merged = await runGit(repoDir(), ["merge", "--ff-only", `origin/${jobsRepo.branch}`]);
  if (!merged.ok) {
    lastError = `merge failed: ${merged.stderr.trim()}`;
    return getJobsRepoStatus();
  }
  lastError = null;
  lastPullAt = new Date().toISOString();
  return getJobsRepoStatus();
}

/** Current jobs-repo status snapshot. */
export async function getJobsRepoStatus(): Promise<JobsRepoStatus> {
  const { jobsRepo } = getSettings();
  const cloned = isCloned();
  let dirty = false, ahead = 0, behind = 0;
  if (cloned) {
    const st = await runGit(repoDir(), ["status", "--porcelain"]);
    dirty = parseStatus(st.stdout).dirty;
    const counts = await runGit(repoDir(), [
      "rev-list", "--left-right", "--count", `HEAD...origin/${jobsRepo.branch}`,
    ]);
    if (counts.ok) {
      const [a, b] = counts.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
      ahead = a ?? 0; behind = b ?? 0;
    }
  }
  return {
    configured: !!jobsRepo.url,
    cloned, dirty, ahead, behind,
    branch: jobsRepo.branch,
    lastPullAt, lastError,
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test src/__tests__/jobsRepo.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/jobsRepo.ts src/__tests__/jobsRepo.test.ts
git commit -m "feat(jobs): jobsRepo module — clone, fast-forward pull, status"
```

---

## Task 4: `syncJobsRepo()` — commit + push

**Files:**
- Modify: `src/jobsRepo.ts`
- Modify: `src/__tests__/jobsRepo.test.ts`

- [ ] **Step 1: Add a failing test**

Append to `src/__tests__/jobsRepo.test.ts`:
```ts
import { buildCommitMessage } from "../jobsRepo";

test("commit message includes a timestamp", () => {
  const msg = buildCommitMessage(new Date("2026-05-22T14:30:00Z"));
  expect(msg).toContain("claudeclaw: sync jobs");
  expect(msg).toContain("2026-05-22");
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `bun test src/__tests__/jobsRepo.test.ts`
Expected: FAIL — `buildCommitMessage` is not exported.

- [ ] **Step 3: Implement `buildCommitMessage` + `syncJobsRepo`**

Append to `src/jobsRepo.ts`:
```ts
/** Auto-generated commit message for a UI-triggered sync. */
export function buildCommitMessage(now: Date = new Date()): string {
  return `claudeclaw: sync jobs (${now.toISOString().replace("T", " ").slice(0, 19)} UTC)`;
}

/** Stage everything, commit (if there are changes), and push. */
export async function syncJobsRepo(): Promise<SyncResult> {
  const { jobsRepo } = getSettings();
  if (!jobsRepo.url || !isCloned()) {
    return { ok: false, committed: false, pushed: false, message: "", error: "jobs repo not configured" };
  }
  await runGit(repoDir(), ["add", "-A"]);
  const status = await runGit(repoDir(), ["status", "--porcelain"]);
  const message = buildCommitMessage();
  let committed = false;
  if (parseStatus(status.stdout).dirty) {
    const commit = await runGit(repoDir(), ["commit", "-m", message]);
    if (!commit.ok) {
      return { ok: false, committed: false, pushed: false, message, error: commit.stderr.trim() };
    }
    committed = true;
  }
  const push = await runGit(repoDir(), ["push", "origin", jobsRepo.branch]);
  if (!push.ok) {
    return { ok: false, committed, pushed: false, message, error: push.stderr.trim() };
  }
  lastError = null;
  return { ok: true, committed, pushed: true, message, error: null };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test src/__tests__/jobsRepo.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/jobsRepo.ts src/__tests__/jobsRepo.test.ts
git commit -m "feat(jobs): syncJobsRepo() — stage, commit, push"
```

---

## Task 5: Daemon wiring — clone on boot + periodic pull

**Files:**
- Modify: `src/commands/start.ts`

- [ ] **Step 1: Import and clone on startup**

In `src/commands/start.ts`, add to imports: `import { ensureJobsRepo, pullJobsRepo } from "../jobsRepo";`.
After `const settings = await loadSettings();` (around line 338), add:
```ts
  await ensureJobsRepo();
```
This runs after `initConfig()` has created the directory and before `loadJobs()`.

- [ ] **Step 2: Register the periodic pull interval**

After the existing hot-reload `setInterval` block (search for `// --- Hot-reload loop`), add a separate interval. Insert near the other `setInterval` calls:
```ts
  // --- Jobs repo periodic pull ---
  if (currentSettings.jobsRepo.url && currentSettings.jobsRepo.intervalSeconds > 0) {
    setInterval(async () => {
      try {
        const status = await pullJobsRepo();
        if (status.lastError) console.warn(`[${ts()}] jobsRepo: ${status.lastError}`);
      } catch (e) {
        console.warn(`[${ts()}] jobsRepo pull error: ${String(e)}`);
      }
    }, currentSettings.jobsRepo.intervalSeconds * 1000);
  }
```
(`ts()` is the existing timestamp helper in this file; `currentSettings` is the existing settings variable used by the hot-reload loop.)

- [ ] **Step 3: Type-check + smoke test**

Run: `bunx tsc --noEmit`
Expected: no errors.
Run: `bun test` (full suite still green).
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/commands/start.ts
git commit -m "feat(jobs): clone jobs repo on boot and pull on a configurable interval"
```

---

## Task 6: Jobs file-service

**Files:**
- Modify: `src/ui/services/jobs.ts`
- Create: `src/__tests__/jobs-fileservice.test.ts`

- [ ] **Step 1: Write failing tests**

`src/__tests__/jobs-fileservice.test.ts`:
```ts
import { test, expect } from "bun:test";
import { isSafeJobPath } from "../ui/services/jobs";

test("accepts simple job file names", () => {
  expect(isSafeJobPath("daily.md")).toBe(true);
  expect(isSafeJobPath("sub/weekly.md")).toBe(true);
});

test("rejects path traversal", () => {
  expect(isSafeJobPath("../secret")).toBe(false);
  expect(isSafeJobPath("a/../../b")).toBe(false);
  expect(isSafeJobPath("/etc/passwd")).toBe(false);
});

test("rejects illegal characters", () => {
  expect(isSafeJobPath("a b.md")).toBe(false);
  expect(isSafeJobPath("a$.md")).toBe(false);
  expect(isSafeJobPath("")).toBe(false);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test src/__tests__/jobs-fileservice.test.ts`
Expected: FAIL — `isSafeJobPath` not exported.

- [ ] **Step 3: Implement the file-service in `src/ui/services/jobs.ts`**

Add imports at the top: `import { readdir, readFile, stat, unlink } from "fs/promises";` (merge with the existing `fs/promises` import) and `import { resolve, relative } from "path";`.
Append:
```ts
export interface JobFileEntry {
  path: string;     // relative to jobs dir
  name: string;
  size: number;
  mtime: string;
  isJob: boolean;   // .md with valid frontmatter
}

/** True when `relPath` is a safe relative path inside the jobs dir. */
export function isSafeJobPath(relPath: string): boolean {
  if (!relPath || relPath.length > 200) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(relPath)) return false;
  if (relPath.startsWith("/") || relPath.includes("..")) return false;
  return true;
}

function resolveSafe(relPath: string): string {
  if (!isSafeJobPath(relPath)) throw new Error("Invalid job path.");
  const dir = getJobsDir();
  const full = resolve(dir, relPath);
  const rel = relative(dir, full);
  if (rel.startsWith("..") || resolve(dir, rel) !== full) throw new Error("Invalid job path.");
  return full;
}

/** List all files in the jobs dir (recursive, one level deep is typical). */
export async function listJobFiles(): Promise<JobFileEntry[]> {
  const dir = getJobsDir();
  const out: JobFileEntry[] = [];
  async function walk(sub: string): Promise<void> {
    let entries: import("fs").Dirent[] = [];
    try { entries = await readdir(join(dir, sub), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) { await walk(rel); continue; }
      const s = await stat(join(dir, rel));
      let isJob = false;
      if (e.name.endsWith(".md")) {
        try { isJob = /^---\s*\n[\s\S]*?\n---/.test(await readFile(join(dir, rel), "utf-8")); } catch {}
      }
      out.push({ path: rel, name: e.name, size: s.size, mtime: s.mtime.toISOString(), isJob });
    }
  }
  await walk("");
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export async function readJobFile(relPath: string): Promise<string> {
  return readFile(resolveSafe(relPath), "utf-8");
}

export async function writeJobFile(relPath: string, content: string): Promise<void> {
  if (content.length > 100_000) throw new Error("File too large.");
  const full = resolveSafe(relPath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf-8");
}

export async function createJobFile(relPath: string): Promise<void> {
  const full = resolveSafe(relPath);
  if (await Bun.file(full).exists()) throw new Error("File already exists.");
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, "---\nschedule: \"0 9 * * *\"\nrecurring: true\n---\n", "utf-8");
}

export async function deleteJobFile(relPath: string): Promise<void> {
  await unlink(resolveSafe(relPath));
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test src/__tests__/jobs-fileservice.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/services/jobs.ts src/__tests__/jobs-fileservice.test.ts
git commit -m "feat(jobs): job file-service (list/read/write/create/delete) with path guard"
```

---

## Task 7: Session-meta store

**Files:**
- Create: `src/ui/services/session-meta.ts`
- Create: `src/__tests__/session-meta.test.ts`

- [ ] **Step 1: Write failing tests**

`src/__tests__/session-meta.test.ts`:
```ts
import { test, expect } from "bun:test";
import { normalizeTitle, mergeMeta } from "../ui/services/session-meta";

test("normalizeTitle trims and caps length", () => {
  expect(normalizeTitle("  hi  ")).toBe("hi");
  expect(normalizeTitle("x".repeat(200)).length).toBe(120);
});

test("mergeMeta applies title and closed flag", () => {
  const store = { sessions: { "id1": { title: "Standup", closed: true } } };
  const merged = mergeMeta({ id: "id1", closed: false } as any, store);
  expect(merged.title).toBe("Standup");
  expect(merged.closed).toBe(true);
});

test("mergeMeta defaults closed to false when absent", () => {
  const merged = mergeMeta({ id: "id2" } as any, { sessions: {} });
  expect(merged.closed).toBe(false);
  expect(merged.title).toBeUndefined();
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test src/__tests__/session-meta.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/ui/services/session-meta.ts`**

```ts
import { join } from "path";

const META_FILE = join(process.cwd(), ".claude", "claudeclaw", "session-meta.json");

export interface SessionMetaEntry { title?: string; closed?: boolean; }
export interface SessionMetaStore { sessions: Record<string, SessionMetaEntry>; }

export function normalizeTitle(raw: string): string {
  return raw.trim().slice(0, 120);
}

export async function getSessionMeta(): Promise<SessionMetaStore> {
  try {
    const data = await Bun.file(META_FILE).json();
    return data && typeof data === "object" && data.sessions ? data : { sessions: {} };
  } catch {
    return { sessions: {} };
  }
}

async function save(store: SessionMetaStore): Promise<void> {
  await Bun.write(META_FILE, JSON.stringify(store, null, 2) + "\n");
}

export async function setSessionTitle(id: string, title: string): Promise<void> {
  const store = await getSessionMeta();
  const entry = store.sessions[id] ?? {};
  const t = normalizeTitle(title);
  if (t) entry.title = t; else delete entry.title;
  store.sessions[id] = entry;
  await save(store);
}

export async function setSessionClosed(id: string, closed: boolean): Promise<void> {
  const store = await getSessionMeta();
  const entry = store.sessions[id] ?? {};
  entry.closed = closed;
  store.sessions[id] = entry;
  await save(store);
}

/** Merge a meta store entry onto a session-info-like object. */
export function mergeMeta<T extends { id: string }>(
  session: T,
  store: SessionMetaStore,
): T & { title?: string; closed: boolean } {
  const entry = store.sessions[session.id] ?? {};
  return { ...session, title: entry.title, closed: entry.closed === true };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test src/__tests__/session-meta.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/services/session-meta.ts src/__tests__/session-meta.test.ts
git commit -m "feat(chat): session-meta store for titles and closed flag"
```

---

## Task 8: Merge session-meta into `listSessions()`

**Files:**
- Modify: `src/ui/services/sessions.ts`

- [ ] **Step 1: Update `SessionInfo` and `listSessions()`**

In `src/ui/services/sessions.ts`:
- Add `title?: string;` and `closed: boolean;` to the `SessionInfo` interface.
- Add `import { getSessionMeta, mergeMeta } from "./session-meta";`.
- Change the signature to `export async function listSessions(includeClosed = false): Promise<SessionInfo[]>`.
- Each `sessions.push({...})` object: the `SessionInfo` literals don't include `title`/`closed` yet — that's fine, they're filled by the merge step below. (TypeScript: add `closed: false` to each pushed literal, or build the array then map. Simplest: keep pushes as-is but assert the array type loosely, then do the merge map.)
- At the end, replace the `sessions.sort(...)` + `return sessions;` with:
```ts
  const meta = await getSessionMeta();
  const merged = sessions.map((s) => mergeMeta(s, meta));
  merged.sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime());
  return includeClosed ? merged : merged.filter((s) => !s.closed);
```
To satisfy the type checker, give each pushed object `closed: false` (it is overwritten by `mergeMeta`), or change the push arrays' element type. Add `closed: false,` to each of the four `sessions.push({ ... })` literals.

- [ ] **Step 2: Type-check + run suite**

Run: `bunx tsc --noEmit && bun test`
Expected: no type errors; all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/ui/services/sessions.ts
git commit -m "feat(chat): merge session titles and closed state into listSessions()"
```

---

## Task 9: New API routes

**Files:**
- Modify: `src/ui/server.ts`

- [ ] **Step 1: Add imports**

In `src/ui/server.ts`, extend imports:
```ts
import { createQuickJob, deleteJob, listJobFiles, readJobFile, writeJobFile, createJobFile, deleteJobFile } from "./services/jobs";
import { setSessionTitle, setSessionClosed, normalizeTitle } from "./services/session-meta";
import { getJobsRepoStatus, syncJobsRepo, pullJobsRepo } from "../jobsRepo";
import { readLogs } from "./services/logs";
import { loadJobs } from "../jobs";
```
(`readLogs` may already be imported — do not duplicate.)

- [ ] **Step 2: Add the job file routes**

After the existing `/api/jobs` route handlers, add (each returns `json(...)`; reuse the existing `json` helper and the `clampInt` import as needed):
```ts
      if (url.pathname === "/api/jobs/files" && req.method === "GET") {
        return json(await listJobFiles());
      }
      if (url.pathname === "/api/jobs/file" && req.method === "GET") {
        const p = url.searchParams.get("path") ?? "";
        try { return json({ path: p, content: await readJobFile(p) }); }
        catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }, 400); }
      }
      if (url.pathname === "/api/jobs/file" && req.method === "PUT") {
        const body = await req.json().catch(() => ({}));
        try { await writeJobFile(String(body.path ?? ""), String(body.content ?? "")); return json({ ok: true }); }
        catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }, 400); }
      }
      if (url.pathname === "/api/jobs/file" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        try { await createJobFile(String(body.path ?? "")); return json({ ok: true }); }
        catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }, 400); }
      }
      if (url.pathname === "/api/jobs/file" && req.method === "DELETE") {
        const p = url.searchParams.get("path") ?? "";
        try { await deleteJobFile(p); return json({ ok: true }); }
        catch (e) { return json({ error: String(e instanceof Error ? e.message : e) }, 400); }
      }
```

- [ ] **Step 3: Add the jobs-repo routes**

```ts
      if (url.pathname === "/api/jobs/repo/status" && req.method === "GET") {
        return json(await getJobsRepoStatus());
      }
      if (url.pathname === "/api/jobs/repo/sync" && req.method === "POST") {
        return json(await syncJobsRepo());
      }
      if (url.pathname === "/api/jobs/repo/pull" && req.method === "POST") {
        return json(await pullJobsRepo());
      }
```

- [ ] **Step 4: Add the session title/close routes**

The existing sessions route matches `/api/sessions`. Add, before the generic sessions handler:
```ts
      {
        const titleMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]+)\/title$/i);
        if (titleMatch && req.method === "PUT") {
          const body = await req.json().catch(() => ({}));
          await setSessionTitle(titleMatch[1], normalizeTitle(String(body.title ?? "")));
          return json({ ok: true });
        }
        const closeMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]+)\/(close|reopen)$/i);
        if (closeMatch && req.method === "POST") {
          await setSessionClosed(closeMatch[1], closeMatch[2].toLowerCase() === "close");
          return json({ ok: true });
        }
      }
```
Update the existing `/api/sessions` GET handler to read `includeClosed`:
```ts
        const includeClosed = url.searchParams.get("includeClosed") === "1";
        return json(await listSessions(includeClosed));
```

- [ ] **Step 5: Add the `/api/home` aggregator**

```ts
      if (url.pathname === "/api/home" && req.method === "GET") {
        const snapshot = opts.getSnapshot();
        const jobs = await loadJobs();
        return json({
          server: await buildState(snapshot),
          jobs: jobs.map((j) => ({ name: j.name, schedule: j.schedule, recurring: j.recurring })),
          repo: await getJobsRepoStatus(),
          logs: await readLogs(20),
        });
      }
```

- [ ] **Step 6: Type-check + smoke test**

Run: `bunx tsc --noEmit`
Expected: no errors.
Run: `bun test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/server.ts
git commit -m "feat(api): job files, jobs-repo, session title/close, and /api/home routes"
```

---

## Task 10: UX shell — rail/hamburger navigation

**Files:**
- Modify: `src/ui/page/template.ts`
- Modify: `src/ui/page/styles.ts`
- Modify: `src/ui/page/script.ts`
- Create: `src/ui/page/sections/` (section fragments — see Tasks 11-14)

This is the structural rewrite. Work UI-iteratively (no unit tests — verify by loading the page).

- [ ] **Step 1: Replace the page chrome in `template.ts`**

Remove `.grain`, `.repo-cta`, `.settings-btn`, `.settings-modal`, `#hb-modal`, `#info-modal`, the `.hero` block, and the `.dock-shell` block. Replace `<main class="stage">` contents with the app shell:
```html
  <div class="app">
    <nav class="rail" id="rail" aria-label="Sections">
      <div class="rail-brand" title="ClaudeClaw">🦞</div>
      <button class="rail-btn rail-btn-active" data-section="home" type="button">🏠<span>Home</span></button>
      <button class="rail-btn" data-section="chats" type="button">💬<span>Chats</span></button>
      <button class="rail-btn" data-section="jobs" type="button">🗂️<span>Jobs</span></button>
      <button class="rail-btn" data-section="settings" type="button">⚙️<span>Settings</span></button>
    </nav>
    <button class="rail-toggle" id="rail-toggle" type="button" aria-label="Menu">☰</button>
    <div class="rail-scrim" id="rail-scrim" hidden></div>
    <main class="section-host">
      <section class="section section-active" id="section-home"></section>
      <section class="section" id="section-chats" hidden></section>
      <section class="section" id="section-jobs" hidden></section>
      <section class="section" id="section-settings" hidden></section>
    </main>
  </div>
```
Each `<section>` body is populated by its section fragment (Tasks 11-14) — concatenate the section HTML strings into the template, or render client-side. Choose: concatenate static HTML into each `<section>` from `sections/*.ts` exports (keeps it server-rendered, no flash).

- [ ] **Step 2: Add shell CSS to `styles.ts`**

Add a `.app` flex layout, `.rail` (fixed-width vertical bar, ~72px desktop), `.rail-btn` (icon + label), `.section-host` (fills remaining space, scrolls), `.section[hidden]` handling. Add a media query at `max-width: 760px`: hide `.rail` by default, show `.rail-toggle` (hamburger, fixed top-left), and when `.rail` has class `rail-open` slide it in as an overlay with `.rail-scrim` visible. Keep the existing color tokens / fonts. Remove now-dead CSS for `.hero`, `.dock`, `.settings-modal`, `.repo-cta`, `.grain`, typewriter, logo art.

- [ ] **Step 3: Add shell JS to `script.ts`**

Replace the old `setActiveTab` tab logic with a section router:
```js
function showSection(name) {
  document.querySelectorAll(".section").forEach(function (s) {
    s.hidden = s.id !== "section-" + name;
    s.classList.toggle("section-active", s.id === "section-" + name);
  });
  document.querySelectorAll(".rail-btn").forEach(function (b) {
    b.classList.toggle("rail-btn-active", b.dataset.section === name);
  });
  document.getElementById("rail").classList.remove("rail-open");
  document.getElementById("rail-scrim").hidden = true;
  if (name === "home") loadHome();
  if (name === "chats") loadSessions();
  if (name === "jobs") loadJobsSection();
  if (name === "settings") loadSettingsSection();
}
document.querySelectorAll(".rail-btn").forEach(function (b) {
  b.addEventListener("click", function () { showSection(b.dataset.section); });
});
document.getElementById("rail-toggle").addEventListener("click", function () {
  var rail = document.getElementById("rail");
  var open = rail.classList.toggle("rail-open");
  document.getElementById("rail-scrim").hidden = !open;
});
document.getElementById("rail-scrim").addEventListener("click", function () {
  document.getElementById("rail").classList.remove("rail-open");
  document.getElementById("rail-scrim").hidden = true;
});
showSection("home");
```
Remove dead code paths: typewriter, dock rendering, old settings/heartbeat/info modal handlers, the old quick-job hero view. (Quick-job creation moves to the Jobs section in Task 13.)

- [ ] **Step 4: Verify the page loads**

Run: `bun run src/index.ts start --web --replace-existing` (or `bun run dev:web`), open `http://127.0.0.1:4632`. The rail shows 4 sections; clicking switches panels; at a narrow viewport the hamburger toggles the rail. Stop the daemon.

- [ ] **Step 5: Commit**

```bash
git add src/ui/page/
git commit -m "feat(ui): full-screen rail/hamburger shell replacing tabs + hero"
```

---

## Task 11: Home section

**Files:**
- Create: `src/ui/page/sections/home.ts`
- Modify: `src/ui/page/script.ts`, `src/ui/page/styles.ts`

- [ ] **Step 1: Home markup**

`sections/home.ts` exports a `homeHtml` string: a card grid with five cards — `#home-recent` (recent actions), `#home-upcoming` (upcoming jobs), `#home-git` (git sync status, with a "Open Jobs" link/button), `#home-server` (server status), `#home-usage` (usage table). Each card: `<article class="card"><h2>…</h2><div class="card-body">…</div></article>`.

- [ ] **Step 2: `loadHome()` in `script.ts`**

Fetch `/api/home` and `/api/usage` (existing). Render:
- recent: `logs.runs` / `logs.daemonLog` tail → list of recent entries.
- upcoming: `jobs` array → name + next run (compute client-side display or just show schedule).
- git: `repo` → "Not configured" / "Clean" / "Dirty — N changes" / ahead/behind + last pull.
- server: `server` → daemon up, uptime, host:port, model.
- usage: reuse the existing usage-table renderer.

- [ ] **Step 3: Home CSS**

`.home-grid` responsive CSS grid (`repeat(auto-fit, minmax(280px, 1fr))`), `.card` styling consistent with tokens. One column under 760px.

- [ ] **Step 4: Verify + commit**

Load the page, confirm Home cards populate. Then:
```bash
git add src/ui/page/
git commit -m "feat(ui): Home section — recent, upcoming, git, server, usage cards"
```

---

## Task 12: Chats section — rename + close

**Files:**
- Create: `src/ui/page/sections/chats.ts`
- Modify: `src/ui/page/script.ts`, `src/ui/page/styles.ts`

- [ ] **Step 1: Chats markup**

`sections/chats.ts` exports `chatsHtml`: the two-pane layout — `.chat-list-pane` (header with "+ New" and a "Show closed" toggle `#show-closed`, plus `#session-list`) and `.chat-main` (the existing chat messages + input form, carried over from the old `#chat-panel`). Preserve all existing chat element IDs (`chat-messages`, `chat-form`, `chat-input`, `chat-send`, `chat-cancel`, `chat-attach`, `chat-file-input`, `chat-attachments`, `load-more-*`, `chat-history-banner`).

- [ ] **Step 2: Update `loadSessions()` rendering**

Each `session-item` gains a controls row:
```js
'<div class="session-actions">'
+ '<button class="session-rename" data-sid="' + s.id + '" title="Rename">✎</button>'
+ '<button class="session-close" data-sid="' + s.id + '" data-closed="' + (s.closed ? '1':'0') + '" title="' + (s.closed?'Reopen':'Close') + '">' + (s.closed?'↺':'×') + '</button>'
+ '</div>'
```
Display `s.title` when set, else the existing preview fallback. Read the `#show-closed` checkbox and fetch `/api/sessions?includeClosed=1` when checked; update the toggle label with the closed count.

- [ ] **Step 3: Wire rename + close handlers**

Delegated click handlers on `#session-list`:
- `.session-rename` → replace the title line with an `<input>`; on Enter/blur `PUT /api/sessions/<sid>/title` with `{title}`, then `loadSessions()`.
- `.session-close` → `POST /api/sessions/<sid>/close` (or `/reopen` when `data-closed="1"`), then `loadSessions()`.
Stop propagation so the row's `browseSession` click does not also fire.

- [ ] **Step 4: Mobile single-column behavior**

CSS under 760px: stack the panes; add a `.chats-show-chat` class on the Chats section that hides the list and shows `.chat-main` with a back button `#chat-back`. `browseSession()` adds the class on mobile; `#chat-back` removes it.

- [ ] **Step 5: Verify + commit**

Load page → Chats: rename a session, close it, toggle "Show closed", reopen. Confirm chat send still works.
```bash
git add src/ui/page/
git commit -m "feat(ui): Chats section with session rename, close, and show-closed toggle"
```

---

## Task 13: Jobs section — explorer + editor + sync

**Files:**
- Create: `src/ui/page/sections/jobs.ts`
- Modify: `src/ui/page/script.ts`, `src/ui/page/styles.ts`

- [ ] **Step 1: Jobs markup**

`sections/jobs.ts` exports `jobsHtml`: two-pane — `.jobs-list-pane` (header with `+ New`, `Delete`; `#job-file-list`) and `.jobs-editor-pane` (a `#jobs-repo-status` line; a `<textarea id="job-editor" class="job-editor" spellcheck="false">`; a button row `Save` `Sync to Git`; a `#jobs-status` message line).

- [ ] **Step 2: `loadJobsSection()` + file operations in `script.ts`**

- `loadJobsSection()` → `GET /api/jobs/files` populate `#job-file-list`; `GET /api/jobs/repo/status` populate `#jobs-repo-status` ("Not a git repo" when `!configured`, else clean/dirty + ahead/behind + last pull).
- Click a file → `GET /api/jobs/file?path=` load into `#job-editor`; track the current path + a dirty flag (textarea `input` event).
- `Save` → `PUT /api/jobs/file` `{path, content}`; on success clear dirty flag, refresh status.
- `+ New` → `prompt()` for a filename (validated `^[A-Za-z0-9._/-]+$`, default `.md`), `POST /api/jobs/file`, reload list.
- `Delete` → confirm, `DELETE /api/jobs/file?path=`, clear editor, reload list.
- `Sync to Git` → `POST /api/jobs/repo/sync`; show result (committed/pushed or the error) in `#jobs-status`; refresh status. Disable the button and show a tooltip when `repo.configured` is false.

- [ ] **Step 3: Editor niceties**

Tab key in `#job-editor` inserts two spaces instead of moving focus. Show "● unsaved" near the Save button when dirty.

- [ ] **Step 4: Jobs CSS**

Two-pane flex like Chats; monospace `.job-editor` (`JetBrains Mono`, fills height, resize none). Single-column + back button under 760px.

- [ ] **Step 5: Verify + commit**

Load page → Jobs: open a file, edit, Save; create + delete a file; with a `jobsRepo` configured, click Sync to Git and confirm the status line updates.
```bash
git add src/ui/page/
git commit -m "feat(ui): Jobs section — file explorer, editor, and Sync to Git"
```

---

## Task 14: Settings section + Dockerfile + docs

**Files:**
- Create: `src/ui/page/sections/settings.ts`, `Dockerfile`, `.dockerignore`, `.env.example`
- Modify: `src/ui/page/script.ts`, `src/ui/page/styles.ts`, `README.md`

- [ ] **Step 1: Settings markup + wiring**

`sections/settings.ts` exports `settingsHtml`: form groups for model, fallback model, heartbeat (enabled/interval/prompt), security level, clock format, and jobsRepo (url/branch/interval). `loadSettingsSection()` reads current values (`/api/state` + `readHeartbeatSettings`); reuse the existing settings update service for heartbeat. jobsRepo fields are display + edit; persist via the settings update path (extend `updateHeartbeatSettings` or add a small settings PATCH route if none exists — if adding a route, name it `PUT /api/settings` and write the merged keys to `settings.json`).

- [ ] **Step 2: Write the `Dockerfile`**

```dockerfile
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_MAJOR=22 \
    HOME=/home/claude \
    BUN_INSTALL=/home/claude/.bun \
    PATH=/home/claude/.bun/bin:/home/claude/.npm-global/bin:/usr/local/bin:/usr/bin:/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git gnupg ripgrep jq unzip less openssl python3 \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash claude
USER claude
WORKDIR /home/claude

RUN mkdir -p /home/claude/.npm-global \
    && npm config set prefix /home/claude/.npm-global \
    && npm install -g @anthropic-ai/claude-code
RUN curl -fsSL https://bun.sh/install | bash

WORKDIR /app
COPY --chown=claude:claude package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY --chown=claude:claude . .

ENV CLAUDECLAW_WEB_ENABLED=true \
    CLAUDECLAW_WEB_HOST=0.0.0.0 \
    CLAUDECLAW_WEB_PORT=4632

EXPOSE 4632
VOLUME ["/app/.claude"]

ENTRYPOINT ["bun", "run", "src/index.ts"]
CMD ["start", "--web"]
```

- [ ] **Step 3: Write `.dockerignore`**

```
node_modules
.git
.claude
images
docs
tests
*.log
```

- [ ] **Step 4: Write `.env.example`**

List every `CLAUDECLAW_*` var from `ENV_OVERRIDES` with a one-line comment each, e.g.:
```
# Model + API
CLAUDECLAW_MODEL=
CLAUDECLAW_API=
# Web dashboard
CLAUDECLAW_WEB_ENABLED=true
CLAUDECLAW_WEB_HOST=0.0.0.0
CLAUDECLAW_WEB_PORT=4632
# Jobs git repo (empty url disables)
CLAUDECLAW_JOBSREPO_URL=
CLAUDECLAW_JOBSREPO_BRANCH=main
CLAUDECLAW_JOBSREPO_INTERVAL=300
# Channels (CLAUDECLAW_* names; bare TELEGRAM_TOKEN etc. also accepted)
CLAUDECLAW_TELEGRAM_TOKEN=
CLAUDECLAW_DISCORD_TOKEN=
CLAUDECLAW_SLACK_BOT_TOKEN=
CLAUDECLAW_SLACK_APP_TOKEN=
```
(Include all the others from the table — model/api/fallback/timezone/api-token/heartbeat/security/stt.)

- [ ] **Step 5: README docs**

Add two README sections: "Configuration & environment overrides" (settings.json is the source of truth; any field can be overridden by its `CLAUDECLAW_*` var; nested arrays/objects are file-only; jobs repo config) and "Run with Docker" (`docker build -t claudeclaw .`, `docker run -p 4632:4632 -v $PWD/.claude:/app/.claude --env-file .env claudeclaw`; Claude auth via the mounted `.claude` volume or `CLAUDE_CODE_OAUTH_TOKEN`).

- [ ] **Step 6: Build the Docker image to verify**

Run: `docker build -t claudeclaw:test .`
Expected: image builds successfully.

- [ ] **Step 7: Full suite + version bumps**

Run: `bun test`
Expected: all PASS.
Run: `bun run bump:plugin-version && bun run bump:marketplace-version`

- [ ] **Step 8: Commit**

```bash
git add Dockerfile .dockerignore .env.example README.md src/ui/page/ .claude-plugin/
git commit -m "feat: Settings section, Dockerfile, env docs, version bumps"
```

---

## Self-Review

**Spec coverage:**
- §1.1 env overrides → Task 1. ✓
- §1.2 Dockerfile → Task 14 (steps 2-3). ✓
- §1.3 jobsRepo + pull → Tasks 2, 3, 5. ✓
- §1.4 file-service → Task 6. ✓
- §1.5 session-meta → Tasks 7, 8. ✓
- §1.6 API routes → Task 9. ✓
- §2.1 shell → Task 10. ✓
- §2.2 Home → Task 11. ✓
- §2.3 Chats rename/close → Task 12. ✓
- §2.4 Jobs editor/sync → Task 13. ✓
- §2.5 Settings → Task 14 (step 1). ✓
- Testing → tests in Tasks 1, 3, 4, 6, 7. ✓

**Type consistency:** `JobsRepoConfig`/`Settings.jobsRepo` defined in Task 2, consumed in Tasks 3/5/9. `JobsRepoStatus`, `SyncResult`, `runGit`, `parseStatus`, `buildCommitMessage` defined in Tasks 3-4, consumed in Task 9. `isSafeJobPath`/`listJobFiles`/`readJobFile`/`writeJobFile`/`createJobFile`/`deleteJobFile` defined in Task 6, consumed in Task 9. `getSessionMeta`/`mergeMeta`/`setSessionTitle`/`setSessionClosed`/`normalizeTitle` defined in Task 7, consumed in Tasks 8-9. `getJobsRepoDir` defined in Task 2, consumed in Task 3. Section fragment exports (`homeHtml`/`chatsHtml`/`jobsHtml`/`settingsHtml`) defined in Tasks 11-14, consumed by `template.ts` (Task 10 wires the host sections; fragment HTML is concatenated as each section task lands).

**Notes for the executor:** Tasks 10-14 are UI work without unit tests — verify by loading the dashboard. The shell in Task 10 references section fragments that arrive in Tasks 11-14; land Task 10 with empty `<section>` bodies, then each later task fills its section and wires its `load*()` function.
