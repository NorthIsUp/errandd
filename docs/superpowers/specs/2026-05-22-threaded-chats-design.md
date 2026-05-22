# Threaded Chats Sidebar

**Date:** 2026-05-22
**Status:** Approved design — ready for implementation
**Branch:** continues on `feat/deployability-jobs-ux` (same PR)

## Goal

Group the flat Chats sidebar into collapsible **threads** — one per job, agent, the Discord set, and web — each showing its most-recent session by default with a disclosure to reveal the rest, and a paginator for threads with many sessions.

## Background

`listSessions()` (`src/ui/services/sessions.ts`) returns a flat `SessionInfo[]`; each session already carries `channel` (`web`/`discord`/`agent`/`job`/`unknown`), `jobName?`, `agent`, `title?`, `closed`, `lastUsedAt`, `turnCount`, and message previews. The Chats sidebar (`loadSessions()` in `src/ui/page/script.ts`) renders this as one flat list of `.session-item` rows.

Thread/job sessions are not rotated — a job reuses one resumable session across runs — so a job thread usually holds one session today, while the Discord set can hold many. The threaded UI is built to display N sessions per thread regardless.

This is a frontend-only change. `listSessions()` and the session model are unchanged.

## Design

### Grouping (client-side, pure function)

A `groupSessionsIntoThreads(sessions)` pass turns `SessionInfo[]` into an ordered `Thread[]`:

```
Thread = { key: string, label: string, kind: "job"|"agent"|"discord"|"web", sessions: SessionInfo[] }
```

Grouping rules, applied per session:
- `jobName` set → thread `key="job:"+jobName`, `label=jobName`, `kind="job"`.
- `channel === "agent"` → `key="agent:"+agent`, `label=agent`, `kind="agent"`.
- `channel === "discord"` → `key="discord"`, `label="Discord"`, `kind="discord"` (all Discord sessions share one thread — this is the high-count case).
- everything else (`web`/`global`/`unknown`) → `key="web"`, `label="Web"`, `kind="web"`.

Within each thread, sessions sort newest-first by `lastUsedAt`. Threads sort by their newest session's `lastUsedAt`, newest first.

### Rendering

The `#session-list` container holds a list of thread blocks. Each thread block:
- **Header row:** a disclosure caret, the thread `label`, a small `kind` badge, and a summary of the thread's most-recent session (its title-or-preview + relative time + session count, e.g. `· 4`). Clicking the header body (not the caret) browses the most-recent session. Clicking the caret toggles disclosure.
- **Body (when expanded):** the thread's sessions rendered as the existing `.session-item` rows — full rename (✎), close (×), and job-link (🗂) affordances preserved, active-session highlight preserved.
- Collapsed by default. Exception: the thread containing the currently-browsed session (`activeBrowseSessionId`) starts expanded.

### Pagination

Per-thread: when an expanded thread has more than `THREAD_PAGE = 10` sessions, render only one page with `‹ prev` / `next ›` controls in the thread body. Each thread keeps its own current-page index in a JS map keyed by thread `key`; it resets to 0 when the thread is collapsed.

### Closed sessions

The existing "Show closed (N)" toggle still applies: closed sessions are filtered from the grouping input unless the toggle is on. A thread whose sessions are all filtered out is not rendered. The closed count continues to come from the full unfiltered list.

### Disclosure state

A JS `Map<threadKey, boolean>` tracks expanded/collapsed across `loadSessions()` re-renders so a refresh of the list (after rename/close) does not collapse what the user opened.

## Files

- `src/ui/page/script.ts` — rewrite `loadSessions()`: fetch (unchanged), `groupSessionsIntoThreads()`, render thread blocks, wire caret toggle + per-thread paginator. Keep the existing per-row rename/close/job-link handlers; they now attach to rows inside thread bodies.
- `src/ui/page/sections/chats.ts` — `#session-list` container is unchanged; no markup change expected beyond what the JS renders. Touch only if a static wrapper is needed.
- `src/ui/page/styles.ts` — styles for `.thread`, `.thread-header`, `.thread-caret`, `.thread-badge`, `.thread-body`, `.thread-paginator`.

No backend, API, or `listSessions()` change.

## Testing

The grouping logic (`groupSessionsIntoThreads`) is simple and lives in the page script string, like all other UI logic in this codebase (the web UI has no bundler and no test harness — consistent with the existing untested `script.ts`). Verification is by loading the dashboard:
- a job session appears under a `job` thread labelled with the job name;
- multiple Discord sessions collapse into one `Discord` thread;
- the caret expands/collapses; collapsed shows the latest session summary;
- a thread with >10 sessions paginates;
- rename / close / job-link still work on rows inside an expanded thread;
- the "Show closed" toggle still filters.

## Out of scope

- Per-run job sessions (each execution as its own session) — jobs deliberately reuse one resumable session; that is a separate backend change.
- Any change to `listSessions()`, the session model, or rotation.
- Server-side pagination — the session list is already bounded (orphan scan caps at 20) so client-side paging is sufficient.
