# Per-Run Job Sessions

**Date:** 2026-05-22
**Status:** Approved design — ready for implementation
**Branch:** continues on `feat/deployability-jobs-ux` (same PR)

## Goal

By default, each run of a job gets a **fresh Claude session** — no context carried from the previous run. A job can opt into the old behavior (one resumed session across all runs) with a frontmatter field. This makes a job's thread in the Chats sidebar accumulate one entry per run.

## Background

`runJob()` in `src/commands/start.ts` calls `run(job.name, prompt, threadId, …)` with `threadId = job.agent ? "agent:<agent>" : job.name`. A fixed `threadId` means `getThreadSession()` resumes the same session every run — the job agent keeps context across runs. The user's decision: most jobs do **not** want kept context; fresh-per-run should be the default.

The threaded Chats sidebar (already built) groups sessions by `jobName` and paginates — it is the display layer this feature fills with data.

## Design

### 1. Job frontmatter field — `src/jobs.ts`

Add `reuse_session` to job frontmatter (snake_case, matching `retry_delay`):

```
reuse_session: true    # resume one session across runs (keeps context)
                       # absent or false → fresh session each run (default)
```

`parseJobFile()` parses it; the `Job` interface gains `reuseSession: boolean` (default `false`). Accepts `true`/`yes`/`1` as true, everything else (including absent) as false.

### 2. Per-run thread IDs — `src/commands/start.ts` (`runJob`)

`runJob` computes the run's `threadId`:
- base = `job.agent ? "agent:" + job.agent : job.name`
- `reuseSession` true → `threadId = base` (today's behavior — one resumed session)
- `reuseSession` false → `threadId = base + ":" + runId`, where `runId` is a compact UTC timestamp (`YYYYMMDDHHmmss`) — unique per run, so `getThreadSession()` misses and `execClaude` bootstraps a fresh session.

No `runner.ts`/`execClaude` change is needed: passing a never-seen `threadId` already triggers the create-new-session path.

Job names are validated to `[A-Za-z0-9._-]` (no `:`), so `:` is a safe separator.

### 3. Grouping per-run sessions back into one job thread — `src/ui/services/sessions.ts`

`listSessions()` currently sets `jobName = threadId` for non-snowflake, non-`agent:` threads. Change it to the base name: `jobName = threadId.split(":")[0]`. So `every-1m:20260522140300` → `jobName = "every-1m"`, and the threaded sidebar (which groups by `jobName`) collects every run of `every-1m` under one thread. The job-file link (`<jobName>.md`) keeps working.

The `channel === "discord"` and `agent:`-prefix branches are unchanged.

### 4. Bounding accumulation — `src/sessionManager.ts`

A once-a-minute fresh job creates ~1,440 thread entries/day in `sessions.json`. Cap it: keep the most recent **25** thread sessions per base job name.

Add `pruneJobSessions(baseName: string, keep = 25): Promise<void>` — removes the oldest `<baseName>:*` thread entries from `sessions.json` beyond `keep`, ordered by `lastUsedAt`. `runJob` calls it after a fresh run's session is created (only when `!reuseSession`). The pruned entries' `.jsonl` transcripts are left on disk (Claude Code owns them); `listSessions`'s orphan scan may still surface a few of the most recent.

### 5. Scope

`reuse_session` applies to **standalone jobs**. Agent-scoped jobs keep their current shared `agent:<agent>` thread (always continuous) — applying per-run IDs there interacts with agent-session handling and is out of scope. Documented as a limitation.

The heartbeat and trigger runs are unaffected — they use the global session, not a job thread.

## Behavior change

Existing job files without `reuse_session` become fresh-per-run on upgrade. This is the intended default. A job that needs cross-run memory must add `reuse_session: true`. Documented in the README jobs section.

## Testing

`bun test`, in `src/__tests__/jobs.test.ts` (exists) and a small addition:
- `parseJobFile` reads `reuse_session: true` → `reuseSession === true`; absent → `false`; `false`/`no` → `false`.
- A `buildJobThreadId(base, reuseSession, runId)` helper (extracted so it is pure and testable): `reuseSession` true → `base`; false → `base + ":" + runId`.
- `pruneJobSessions` against a temp `sessions.json`: with 30 `foo:*` entries and `keep=25`, the 5 oldest by `lastUsedAt` are removed and unrelated threads (snowflakes, other jobs) are untouched.

## Out of scope

- Per-run sessions for agent-scoped jobs.
- A UI control to set `reuse_session` (it is edited in the job file via the Jobs editor like any other frontmatter).
- Garbage-collecting pruned `.jsonl` transcript files.
- Making the `keep` cap configurable (hardcoded 25).
