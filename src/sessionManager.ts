import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "path";

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "clawdcode");
/** Legacy single-blob store — migrated from once, then left as a backup. */
const SESSIONS_FILE = join(HEARTBEAT_DIR, "sessions.json");
/** Append-only log: one ThreadSession snapshot (or tombstone) per line. */
const SESSIONS_LOG = join(HEARTBEAT_DIR, "sessions.jsonl");

export interface ThreadSession {
  sessionId: string;
  threadId: string;
  createdAt: string;
  lastUsedAt: string;
  turnCount: number;
  compactWarned: boolean;
}

// ── Append-only jsonl store ─────────────────────────────────────────────────
//
// The store was a single `sessions.json` rewritten wholesale on every change.
// Two concurrent read-modify-write cycles could clobber each other, and a
// truncate-write racing a reader could leave corrupt JSON (→ every session lost
// on next boot). It also rewrote the whole file per turn-increment.
//
// Now each mutation APPENDS one line to `sessions.jsonl` — a full ThreadSession
// snapshot, or a `{threadId, deleted:true}` tombstone. Reads fold the log
// (last line per threadId wins; tombstone removes). Appends never truncate, so
// they can't corrupt the file or clobber an unrelated thread. Periodic
// compaction (the prune paths) rewrites the log from the in-memory cache via
// temp+rename. All disk writes run through one serialized chain so a compaction
// can't interleave with an append.

/** Authoritative in-memory state (threadId → session). Folded from the log. */
let cache: Record<string, ThreadSession> | null = null;
/** Memoizes the first (async) rebuild so concurrent callers share one load. */
let loadInFlight: Promise<Record<string, ThreadSession>> | null = null;
/** Serializes every disk write (appends + compactions) — no interleaving. */
let writeChain: Promise<void> = Promise.resolve();

export type LogEntry =
  | { threadId: string; deleted: true }
  | { threadId: string; session: ThreadSession };

/** Parse one log line into a tombstone or a normalized session, or null when
 *  malformed / missing required fields (a torn trailing line is just skipped). */
function parseLogLine(line: string): LogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const threadId = obj.threadId;
  if (typeof threadId !== "string") return null;
  if (obj.deleted === true) return { threadId, deleted: true };
  if (typeof obj.sessionId !== "string") return null;
  const createdAt = typeof obj.createdAt === "string" ? obj.createdAt : new Date(0).toISOString();
  return {
    threadId,
    session: {
      sessionId: obj.sessionId,
      threadId,
      createdAt,
      lastUsedAt: typeof obj.lastUsedAt === "string" ? obj.lastUsedAt : createdAt,
      turnCount: typeof obj.turnCount === "number" ? obj.turnCount : 0,
      compactWarned: obj.compactWarned === true,
    },
  };
}

/**
 * Pure: fold an ordered jsonl log into the current thread map. Later lines win;
 * a `{threadId, deleted:true}` tombstone removes a thread; malformed/partial
 * lines and records missing required fields are skipped (a torn trailing line
 * from a crash mid-append must never poison the whole store).
 */
export function foldSessionLog(lines: string[]): Record<string, ThreadSession> {
  const out: Record<string, ThreadSession> = {};
  for (const line of lines) {
    const entry = parseLogLine(line);
    if (!entry) continue;
    if ("deleted" in entry) {
      delete out[entry.threadId];
    } else {
      out[entry.threadId] = entry.session;
    }
  }
  return out;
}

/**
 * Read the FULL append-only log as ordered entries — including superseded
 * records (every line, not just the folded current state). The recovery cleanup
 * uses this: a thread clobbered by a skip still has its earlier real-session
 * line in the log, so the history is recoverable without guessing.
 */
export async function readSessionLog(): Promise<LogEntry[]> {
  let text: string;
  try {
    text = await readFile(SESSIONS_LOG, "utf-8");
  } catch {
    return [];
  }
  const out: LogEntry[] = [];
  for (const line of text.split("\n")) {
    const entry = parseLogLine(line);
    if (entry) out.push(entry);
  }
  return out;
}

/** Serialize a write task after all prior writes (runs even if a prior failed). */
function enqueueWrite(task: () => Promise<void>): Promise<void> {
  writeChain = writeChain.then(task, task);
  return writeChain;
}

/** Append one record (snapshot or tombstone) to the log. */
function appendLine(record: object): Promise<void> {
  return enqueueWrite(async () => {
    await mkdir(HEARTBEAT_DIR, { recursive: true });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(SESSIONS_LOG, `${JSON.stringify(record)}\n`);
  });
}

/** Rewrite the whole log from `threads` (compaction) via temp+rename (atomic). */
function rewriteLog(threads: Record<string, ThreadSession>): Promise<void> {
  return enqueueWrite(async () => {
    await mkdir(HEARTBEAT_DIR, { recursive: true });
    const body = Object.values(threads)
      .map((t) => JSON.stringify(t))
      .join("\n");
    const tmp = `${SESSIONS_LOG}.tmp`;
    await Bun.write(tmp, body ? `${body}\n` : "");
    await rename(tmp, SESSIONS_LOG);
  });
}

/** Rebuild the cache from disk: prefer the jsonl log; else read the legacy json
 *  blob READ-ONLY (the write-conversion is a registered migration, see
 *  `migrateLegacySessionStore` — this keeps reads working if it hasn't run yet,
 *  rather than scattering migration writes through the read path). */
async function rebuild(): Promise<Record<string, ThreadSession>> {
  try {
    const text = await readFile(SESSIONS_LOG, "utf-8");
    return foldSessionLog(text.split("\n"));
  } catch {
    // No log yet — fall through to the legacy blob.
  }
  try {
    const data = (await Bun.file(SESSIONS_FILE).json()) as { threads?: Record<string, ThreadSession> };
    return data?.threads ?? {};
  } catch {
    return {};
  }
}

/**
 * Migration (run-once, via the maintenance harness): convert the legacy
 * single-blob `sessions.json` to the append-only `sessions.jsonl` store.
 * Idempotent — a no-op once the log exists. Returns a one-line summary.
 */
export async function migrateLegacySessionStore(): Promise<string> {
  try {
    await readFile(SESSIONS_LOG, "utf-8");
    return "already on sessions.jsonl";
  } catch {
    // No log yet — convert the legacy blob below.
  }
  let threads: Record<string, ThreadSession>;
  try {
    const data = (await Bun.file(SESSIONS_FILE).json()) as { threads?: Record<string, ThreadSession> };
    threads = data?.threads ?? {};
  } catch {
    return "no legacy sessions.json to migrate";
  }
  const n = Object.keys(threads).length;
  if (n === 0) {
    return "legacy sessions.json was empty";
  }
  await rewriteLog(threads);
  cache = null; // force a re-fold from the new log on next access
  loadInFlight = null;
  return `migrated ${n} thread session(s) from sessions.json → sessions.jsonl`;
}

/** Load the cache (memoized). */
async function loadThreads(): Promise<Record<string, ThreadSession>> {
  if (cache) return cache;
  if (!loadInFlight) {
    loadInFlight = rebuild().then((t) => {
      cache = t;
      loadInFlight = null;
      return t;
    });
  }
  return loadInFlight;
}

/** Test-only: reset the in-memory cache so the next read re-folds from disk. */
export function __resetSessionCacheForTests(): void {
  cache = null;
  loadInFlight = null;
}

/**
 * Get session for a thread and mark it as just-used (bumps `lastUsedAt`,
 * appending one log line). For ACTIVE-use paths (a run touching the thread).
 * Read paths that only need the sessionId should use `peekThreadSession` (below)
 * to avoid the extra append. Returns null if no session exists yet.
 */
export async function getThreadSession(
  threadId: string,
): Promise<{ sessionId: string; turnCount: number; compactWarned: boolean } | null> {
  const threads = await loadThreads();
  const session = threads[threadId];
  if (!session) return null;

  if (typeof session.turnCount !== "number") session.turnCount = 0;
  if (typeof session.compactWarned !== "boolean") session.compactWarned = false;

  session.lastUsedAt = new Date().toISOString();
  await appendLine(session);

  return {
    sessionId: session.sessionId,
    turnCount: session.turnCount,
    compactWarned: session.compactWarned,
  };
}

/** Create a new thread session after Claude outputs a session_id. */
export async function createThreadSession(threadId: string, sessionId: string): Promise<void> {
  const threads = await loadThreads();
  const now = new Date().toISOString();
  const session: ThreadSession = {
    sessionId,
    threadId,
    createdAt: now,
    lastUsedAt: now,
    turnCount: 0,
    compactWarned: false,
  };
  threads[threadId] = session;
  await appendLine(session);
}

/**
 * Re-point a thread at a different (recovered) session, preserving the given
 * metadata. Used by the `recover-clobbered-threads` cleanup to restore a thread
 * whose mapping was overwritten by a skip placeholder back to its real
 * transcript. Append-only like every other mutation.
 */
export async function remapThreadSession(
  threadId: string,
  sessionId: string,
  meta: { turnCount?: number; createdAt?: string; lastUsedAt?: string } = {},
): Promise<void> {
  const threads = await loadThreads();
  const now = new Date().toISOString();
  const prev = threads[threadId];
  const session: ThreadSession = {
    sessionId,
    threadId,
    createdAt: meta.createdAt ?? prev?.createdAt ?? now,
    lastUsedAt: meta.lastUsedAt ?? now,
    turnCount: meta.turnCount ?? prev?.turnCount ?? 0,
    compactWarned: false,
  };
  threads[threadId] = session;
  await appendLine(session);
}

/** Remove a thread session (e.g., on thread delete/archive). */
export async function removeThreadSession(threadId: string): Promise<void> {
  const threads = await loadThreads();
  if (!threads[threadId]) return;
  delete threads[threadId];
  await appendLine({ threadId, deleted: true });
}

/** Increment turn counter for a thread session. */
export async function incrementThreadTurn(threadId: string): Promise<number> {
  const threads = await loadThreads();
  const session = threads[threadId];
  if (!session) return 0;
  if (typeof session.turnCount !== "number") session.turnCount = 0;
  session.turnCount += 1;
  await appendLine(session);
  return session.turnCount;
}

/** Mark compact warning sent for a thread session. */
export async function markThreadCompactWarned(threadId: string): Promise<void> {
  const threads = await loadThreads();
  const session = threads[threadId];
  if (!session) return;
  session.compactWarned = true;
  await appendLine(session);
}

/** List all active thread sessions. */
export async function listThreadSessions(): Promise<ThreadSession[]> {
  const threads = await loadThreads();
  return Object.values(threads);
}

/** Peek at a thread session without updating lastUsedAt. */
export async function peekThreadSession(threadId: string): Promise<ThreadSession | null> {
  const threads = await loadThreads();
  return threads[threadId] ?? null;
}

/**
 * Pure helper: given a threads record, return the subset to keep for baseName.
 * Keeps the `keep` most-recent entries (by lastUsedAt) whose threadId is
 * `baseName` or starts with `baseName + ":"`. All other entries are passed through unchanged.
 */
export function selectThreadsToKeep(
  threads: Record<string, ThreadSession>,
  baseName: string,
  keep: number,
): Record<string, ThreadSession> {
  const prefix = baseName + ":";
  const matches = Object.values(threads).filter(
    (t) => t.threadId === baseName || t.threadId.startsWith(prefix),
  );
  matches.sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime());
  const toRemove = new Set(matches.slice(keep).map((t) => t.threadId));
  const result: Record<string, ThreadSession> = {};
  for (const [id, session] of Object.entries(threads)) {
    if (!toRemove.has(id)) result[id] = session;
  }
  return result;
}

/** Keep only the most-recent `keep` thread sessions whose threadId is `<baseName>` or `<baseName>:*`. */
export async function pruneJobSessions(baseName: string, keep = 25): Promise<void> {
  const threads = await loadThreads();
  const kept = selectThreadsToKeep(threads, baseName, keep);
  if (Object.keys(kept).length === Object.keys(threads).length) return;
  cache = kept;
  await rewriteLog(kept);
}

/**
 * Pure helper: drop every thread session whose `lastUsedAt` is older than
 * `now - maxAgeMs`. Threads with a missing/unparseable `lastUsedAt` are kept
 * (treated as recent — never silently evict on a bad timestamp). Returns the
 * surviving record; the count removed is `before - after`.
 */
export function selectFreshSessions(
  threads: Record<string, ThreadSession>,
  nowMs: number,
  maxAgeMs: number,
): Record<string, ThreadSession> {
  const cutoff = nowMs - maxAgeMs;
  const result: Record<string, ThreadSession> = {};
  for (const [id, session] of Object.entries(threads)) {
    const used = Date.parse(session.lastUsedAt);
    if (Number.isNaN(used) || used >= cutoff) {
      result[id] = session;
    }
  }
  return result;
}

/**
 * Age-based compaction for the session store: drop thread sessions idle longer
 * than `maxAgeMs` (default 30 days). Unlike `pruneJobSessions` (keep-N keyed on
 * a job baseName), this is uniform — it covers hook/agent/reuse threads that the
 * per-job keep-N misses, so the store stays bounded by activity, not by total
 * subjects ever seen. Dropping a stale thread only forgets its threadId→session
 * mapping; resuming that long-dead thread simply starts a fresh session.
 * Rewrites the log (compaction) only when something is stale. Returns the count.
 */
export async function pruneStaleSessions(
  maxAgeMs = 30 * 24 * 60 * 60 * 1000,
  nowMs = Date.now(),
): Promise<number> {
  const threads = await loadThreads();
  const before = Object.keys(threads).length;
  const kept = selectFreshSessions(threads, nowMs, maxAgeMs);
  const removed = before - Object.keys(kept).length;
  if (removed > 0) {
    cache = kept;
    await rewriteLog(kept);
  }
  return removed;
}
