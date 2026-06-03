/**
 * Durable per-thread hook message queue (SQLite, on the PVC).
 *
 * Each incoming webhook delivery that matches a routine becomes a queued
 * "message" keyed to a thread (`<job>:hook:pr-<num>-<slug>`). A per-thread
 * drain worker claims all *ready pending* messages for a thread at once
 * (coalescing rapid comments into a single resumed turn), runs them, and marks
 * them done/failed. Because it's on disk it survives the daemon's ~10-min
 * auto-update restart: the queue replays on boot, dedups GitHub retries, defers
 * while Claude is rate-limited, and retries transient failures.
 *
 * One daemon process owns the DB, so within-process statement execution is the
 * only concurrency — no cross-process locking needed beyond SQLite's WAL.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";

const DB_PATH = join(process.cwd(), ".claude", "clawdcode", "hook-queue.db");

export type QueueStatus = "pending" | "running" | "done" | "failed";

export interface QueuedMessage {
  /** Delivery id — the dedup key (GitHub X-GitHub-Delivery, Sentry Request-ID,
   *  Datadog derived id). A re-delivered webhook with the same id is ignored. */
  id: string;
  /** `<job>:hook:pr-<num>-<slug>` — the resumed Claude session this drains to. */
  threadId: string;
  jobName: string;
  event: string;
  /** Hook scope, e.g. `pr-1542-fix-thing`. */
  scope: string;
  /** Full parsed webhook payload. */
  payload: unknown;
  enqueuedAt: number;
  status: QueueStatus;
  /** Run attempts so far (incremented on each claim that ends in failure). */
  attempts: number;
  /** Epoch ms before which this message must not run (rate-limit defer /
   *  retry backoff). 0 = ready now. */
  notBefore: number;
  /** Repo + PR number for the PR-centric grouping view. Null for non-PR. */
  prRepo: string | null;
  prNumber: number | null;
  /** Last failure message, if any. */
  error: string | null;
  updatedAt: number;
}

/** What a caller provides to enqueue — the durable fields default in. */
export interface EnqueueInput {
  id: string;
  threadId: string;
  jobName: string;
  event: string;
  scope: string;
  payload: unknown;
  prRepo?: string | null;
  prNumber?: number | null;
  enqueuedAt?: number;
}

interface Row {
  id: string;
  thread_id: string;
  job_name: string;
  event: string;
  scope: string;
  payload: string;
  enqueued_at: number;
  status: QueueStatus;
  attempts: number;
  not_before: number;
  pr_repo: string | null;
  pr_number: number | null;
  error: string | null;
  updated_at: number;
}

function toMessage(r: Row): QueuedMessage {
  let payload: unknown = null;
  try {
    payload = JSON.parse(r.payload);
  } catch {
    payload = null;
  }
  return {
    id: r.id,
    threadId: r.thread_id,
    jobName: r.job_name,
    event: r.event,
    scope: r.scope,
    payload,
    enqueuedAt: r.enqueued_at,
    status: r.status,
    attempts: r.attempts,
    notBefore: r.not_before,
    prRepo: r.pr_repo,
    prNumber: r.pr_number,
    error: r.error,
    updatedAt: r.updated_at,
  };
}

export class HookQueue {
  private db: Database;

  constructor(path: string = DB_PATH) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id          TEXT PRIMARY KEY,
        thread_id   TEXT NOT NULL,
        job_name    TEXT NOT NULL,
        event       TEXT NOT NULL,
        scope       TEXT NOT NULL,
        payload     TEXT NOT NULL,
        enqueued_at INTEGER NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        attempts    INTEGER NOT NULL DEFAULT 0,
        not_before  INTEGER NOT NULL DEFAULT 0,
        pr_repo     TEXT,
        pr_number   INTEGER,
        error       TEXT,
        updated_at  INTEGER NOT NULL
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_messages_thread_status ON messages(thread_id, status, not_before)",
    );
  }

  /** Enqueue a delivery. Returns true if newly inserted, false if a message
   *  with this delivery id already exists (durable dedup of GitHub retries —
   *  including ones that arrive after a restart). */
  enqueue(input: EnqueueInput): boolean {
    const now = input.enqueuedAt ?? Date.now();
    const res = this.db.run(
      `INSERT OR IGNORE INTO messages
         (id, thread_id, job_name, event, scope, payload, enqueued_at, status, attempts, not_before, pr_repo, pr_number, error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?, NULL, ?)`,
      [
        input.id,
        input.threadId,
        input.jobName,
        input.event,
        input.scope,
        JSON.stringify(input.payload ?? null),
        now,
        input.prRepo ?? null,
        input.prNumber ?? null,
        now,
      ],
    );
    return res.changes > 0;
  }

  /** Claim ALL ready-pending messages for one thread, marking them `running`,
   *  and return them oldest-first. This is the coalesce step: the worker runs
   *  them as a single resumed turn. Returns [] if nothing is ready. */
  claimThread(threadId: string, now: number = Date.now()): QueuedMessage[] {
    const rows = this.db
      .query<Row, [string, number]>(
        "SELECT * FROM messages WHERE thread_id = ? AND status = 'pending' AND not_before <= ? ORDER BY enqueued_at ASC",
      )
      .all(threadId, now);
    if (rows.length === 0) {
      return [];
    }
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    this.db.run(
      `UPDATE messages SET status = 'running', updated_at = ? WHERE id IN (${placeholders})`,
      [now, ...ids],
    );
    return rows.map(toMessage);
  }

  /** Mark messages done (success) or failed (terminal). */
  complete(ids: string[], status: "done" | "failed", error: string | null = null): void {
    if (ids.length === 0) {
      return;
    }
    const now = Date.now();
    const placeholders = ids.map(() => "?").join(",");
    this.db.run(
      `UPDATE messages SET status = ?, error = ?, updated_at = ? WHERE id IN (${placeholders})`,
      [status, error, now, ...ids],
    );
  }

  /** Return claimed messages to `pending` with a `notBefore` in the future and
   *  a bumped attempt count — used to defer on rate-limit or back off a retry. */
  defer(ids: string[], notBefore: number, error: string | null = null): void {
    if (ids.length === 0) {
      return;
    }
    const now = Date.now();
    const placeholders = ids.map(() => "?").join(",");
    this.db.run(
      `UPDATE messages SET status = 'pending', not_before = ?, attempts = attempts + 1, error = ?, updated_at = ?
         WHERE id IN (${placeholders})`,
      [notBefore, error, now, ...ids],
    );
  }

  /** Recover from a crash/restart: any message left `running` (its worker died
   *  mid-run) is reset to `pending` so it replays. Call once on boot. */
  requeueStuckRunning(): number {
    const now = Date.now();
    const res = this.db.run(
      "UPDATE messages SET status = 'pending', updated_at = ? WHERE status = 'running'",
      [now],
    );
    return res.changes;
  }

  /** Distinct thread ids that have at least one ready-pending message. The
   *  drain loop iterates these. */
  readyThreadIds(now: number = Date.now()): string[] {
    return this.db
      .query<{ thread_id: string }, [number]>(
        "SELECT DISTINCT thread_id FROM messages WHERE status = 'pending' AND not_before <= ? ORDER BY thread_id",
      )
      .all(now)
      .map((r) => r.thread_id);
  }

  /** List messages for inspection / the UI. Optionally filter by status or
   *  thread. Newest-first. */
  list(opts: { status?: QueueStatus; threadId?: string; limit?: number } = {}): QueuedMessage[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.status) {
      where.push("status = ?");
      args.push(opts.status);
    }
    if (opts.threadId) {
      where.push("thread_id = ?");
      args.push(opts.threadId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = opts.limit ?? 500;
    args.push(limit);
    return this.db
      .query<Row, (string | number)[]>(
        `SELECT * FROM messages ${clause} ORDER BY enqueued_at DESC LIMIT ?`,
      )
      .all(...args)
      .map(toMessage);
  }

  /** Pending-message depth per thread — what the queue-visualization needs. */
  pendingDepthByThread(now: number = Date.now()): Record<string, number> {
    const rows = this.db
      .query<{ thread_id: string; n: number }, [number]>(
        "SELECT thread_id, COUNT(*) AS n FROM messages WHERE status = 'pending' AND not_before <= ? GROUP BY thread_id",
      )
      .all(now);
    const out: Record<string, number> = {};
    for (const r of rows) {
      out[r.thread_id] = r.n;
    }
    return out;
  }

  /** Drop terminal (done/failed) rows older than ttl, keeping the DB small. */
  prune(ttlMs: number, now: number = Date.now()): number {
    const cutoff = now - ttlMs;
    const res = this.db.run(
      "DELETE FROM messages WHERE status IN ('done', 'failed') AND updated_at < ?",
      [cutoff],
    );
    return res.changes;
  }

  close(): void {
    this.db.close();
  }
}

let singleton: HookQueue | null = null;

/** Process-wide queue at the canonical PVC path. */
export function getHookQueue(): HookQueue {
  if (!singleton) {
    singleton = new HookQueue();
  }
  return singleton;
}
