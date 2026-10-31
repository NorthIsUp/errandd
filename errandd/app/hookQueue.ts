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
import type { Database } from "bun:sqlite";
import { openDatabase, storageTable, enableCompression, countedMutation } from "./sqlite";
import { join } from "node:path";
import type { DeliveryField, DeliveryKeys } from "../shared/deliveryTypes";
import { fibBackoffMs } from "./rate-limit";
import type { HookDrainThread } from "./hookQueueScheduler";
import { extractHookScope } from "./hooks/match";

const DB_PATH = join(process.cwd(), ".claude", "errandd", "hook-queue.db");

export type QueueStatus = "pending" | "running" | "done" | "failed";
/** The agent's result once a `done` message has run — distinct from the queue
 *  lifecycle `status`. "pass" = the agent ran and chose to no-op (`[skip]`). */
export type QueueOutcomeResult = "ok" | "pass" | "error";

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
  /** Capacity deferrals, counted separately so they drive backoff without
   *  consuming the ordinary failure retry budget. */
  rateLimitAttempts: number;
  /** Epoch ms before which this message must not run (rate-limit defer /
   *  retry backoff). 0 = ready now. */
  notBefore: number;
  /** Repo + PR number for the PR-centric grouping view. Null for non-PR. */
  prRepo: string | null;
  prNumber: number | null;
  /** The two labeled "key" columns (action + pr/branch, etc.) — extracted at
   *  enqueue so the UI can show the action + a critical detail per message. */
  keys?: DeliveryKeys;
  /** "Most important" extracted fields (repo/PR/author/comment/…). */
  fields?: DeliveryField[];
  /** Agent result once `done` (ok / pass / error). Null until run. */
  outcome: QueueOutcomeResult | null;
  /** Last failure message, if any. */
  error: string | null;
  updatedAt: number;
  /** W3C `traceparent` of the webhook span this delivery came in on, minted at
   *  intake. The run span that drains this message LINKS back to it. Null when
   *  telemetry was off at intake. */
  traceparent?: string | null;
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
  keys?: DeliveryKeys;
  fields?: DeliveryField[];
  enqueuedAt?: number;
  /** Epoch ms before which the message must not run (debounce defer). 0 /
   *  omitted = ready immediately. */
  notBefore?: number;
  /** W3C `traceparent` of the webhook intake span (telemetry span-link source). */
  traceparent?: string | null;
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
  rate_limit_attempts: number;
  not_before: number;
  pr_repo: string | null;
  pr_number: number | null;
  keys: string | null;
  fields: string | null;
  outcome: string | null;
  error: string | null;
  updated_at: number;
  trace_id: string | null;
}

// Dashboard/status reads must not load and JSON-parse payloads that are then
// immediately discarded. Workers and replay keep the full-payload default.
const METADATA_COLUMNS = [
  "id",
  "thread_id",
  "job_name",
  "event",
  "scope",
  "enqueued_at",
  "status",
  "attempts",
  "rate_limit_attempts",
  "not_before",
  "pr_repo",
  "pr_number",
  "keys",
  "fields",
  "outcome",
  "error",
  "updated_at",
  "trace_id",
];
function columns(includePayload: boolean, alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  if (includePayload) return `${prefix}*`;
  return `${METADATA_COLUMNS.map((column) => `${prefix}${column}`).join(", ")}, NULL AS payload`;
}

function parseJson<T>(s: string | null): T | undefined {
  if (s == null) {
    return undefined;
  }
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

function toMessage(r: Row): QueuedMessage {
  return {
    id: r.id,
    threadId: r.thread_id,
    jobName: r.job_name,
    event: r.event,
    scope: r.scope,
    payload: parseJson<unknown>(r.payload) ?? null,
    enqueuedAt: r.enqueued_at,
    status: r.status,
    attempts: r.attempts,
    rateLimitAttempts: r.rate_limit_attempts,
    notBefore: r.not_before,
    prRepo: r.pr_repo,
    prNumber: r.pr_number,
    keys: parseJson<DeliveryKeys>(r.keys),
    fields: parseJson<DeliveryField[]>(r.fields),
    outcome: (r.outcome as QueueOutcomeResult | null) ?? null,
    error: r.error,
    updatedAt: r.updated_at,
    traceparent: r.trace_id,
  };
}

export class HookQueue {
  private db: Database;
  private listeners = new Set<() => void>();

  /** Notified after any mutation (enqueue/claim/complete/defer/replay) so the
   *  UI's queue stream can push a fresh snapshot. Returns an unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // a slow consumer must not break queue operations
      }
    }
  }

  constructor(path: string = DB_PATH) {
    this.db = openDatabase(path);
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
        keys        TEXT,
        fields      TEXT,
        outcome     TEXT,
        error       TEXT,
        updated_at  INTEGER NOT NULL
      )
    `);
    // Columns added after the initial schema — no-op when they already exist.
    for (const col of [
      "keys TEXT",
      "fields TEXT",
      "outcome TEXT",
      "trace_id TEXT",
      "rate_limit_attempts INTEGER NOT NULL DEFAULT 0",
    ]) {
      try {
        this.db.run(`ALTER TABLE ${storageTable(this.db, "messages")} ADD COLUMN ${col}`);
      } catch {
        // column already present
      }
    }
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_messages_thread_status ON ${storageTable(this.db, "messages")}(thread_id, status, not_before)`,
    );
    // The single thread-first index above only serves thread-scoped claims. The
    // dashboard + drain hot paths filter status-first or order by a timestamp,
    // which otherwise fall back to full table scans + temp b-tree sorts (verified
    // via EXPLAIN QUERY PLAN). Add covering indexes for each:
    //  - listLatestPerThread (the sidebar query, every page load + SSE): the
    //    per-thread "latest" correlated subquery orders by (thread_id, updated_at).
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_messages_thread_updated ON ${storageTable(this.db, "messages")}(thread_id, updated_at DESC)`,
    );
    //  - readyThreadIds + pendingDepthByThread (drain loop, every 3s): filter on
    //    (status, not_before).
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_messages_status_notbefore ON ${storageTable(this.db, "messages")}(status, not_before)`,
    );
    //  - list({status}) ORDER BY enqueued_at DESC (Runs view): filter status,
    //    order by enqueued_at — without this it sorts the whole table each call.
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_messages_status_enqueued ON ${storageTable(this.db, "messages")}(status, enqueued_at DESC)`,
    );
    // Unfiltered and thread-filtered inspection must also preserve timestamp
    // ordering without sorting every retained payload row.
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_messages_enqueued ON ${storageTable(this.db, "messages")}(enqueued_at DESC)`);
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_messages_thread_enqueued ON ${storageTable(this.db, "messages")}(thread_id, enqueued_at DESC)`,
    );
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_messages_updated ON ${storageTable(this.db, "messages")}(updated_at DESC)`);
    enableCompression(this.db, "messages", "payload");
    this.rehomePendingCve();
  }

  /** Upgrade waiting work to package lanes without rewriting running or completed chats. */
  private rehomePendingCve(): void {
    const rows = this.db.query<{ id: string; thread_id: string; payload: string }, []>(
      "SELECT id,thread_id,payload FROM messages WHERE status='pending' AND event='cve:alert'",
    ).all();
    this.db.transaction(() => {
      for (const row of rows) {
        const scope = extractHookScope("cve:alert", parseJson<unknown>(row.payload));
        const split = row.thread_id.lastIndexOf(":hook:");
        if (!scope?.startsWith("cve-remediation-") || split < 0) continue;
        const thread = `${row.thread_id.slice(0, split)}:hook:${scope}`;
        if (thread !== row.thread_id) this.db.run(
          "UPDATE messages SET thread_id=?,scope=? WHERE id=? AND status='pending'",
          [thread, scope, row.id],
        );
      }
    }).immediate();
  }

  /** Enqueue a delivery. Returns true if newly inserted, false if a message
   *  with this delivery id already exists (durable dedup of GitHub retries —
   *  including ones that arrive after a restart). */
  enqueue(input: EnqueueInput): boolean {
    const now = input.enqueuedAt ?? Date.now();
    const notBefore = input.notBefore ?? 0;
    const inserted = this.db.transaction(() => {
      if (this.db.query("SELECT 1 FROM messages WHERE id=?").get(input.id)) return false;
      this.db.run(
      `INSERT OR IGNORE INTO messages
         (id, thread_id, job_name, event, scope, payload, enqueued_at, status, attempts, not_before, pr_repo, pr_number, keys, fields, error, updated_at, trace_id, rate_limit_attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, NULL, ?, ?, 0)`,
      [
        input.id,
        input.threadId,
        input.jobName,
        input.event,
        input.scope,
        JSON.stringify(input.payload ?? null),
        now,
        notBefore,
        input.prRepo ?? null,
        input.prNumber ?? null,
        input.keys ? JSON.stringify(input.keys) : null,
        input.fields ? JSON.stringify(input.fields) : null,
        now,
        input.traceparent ?? null,
      ],
    );
      return true;
    }).immediate();
    if (inserted) this.emit();
    return inserted;
  }

  /** Resolve only waiting CVE work; running agent turns are left to finish. */
  resolvePendingCve(job: string, repository: string, aliases: string[]): number {
    const rows = this.db.query<{ id: string; payload: string }, [string]>(
      "SELECT id,payload FROM messages WHERE status='pending' AND event='cve:alert' AND job_name=?").all(job);
    const knownAliases = new Set(aliases);
    const ids = rows.filter(row => {
      const payload = parseJson<{ id?: string; aliases?: string[]; targetRepository?: string }>(row.payload);
      return payload?.targetRepository?.toLowerCase() === repository.toLowerCase() &&
        [payload.id, ...(payload.aliases ?? [])].some(alias => alias && knownAliases.has(alias));
    }).map(row => row.id);
    if (!ids.length) return 0;
    let changed = 0;
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500);
      const where = `status='pending' AND id IN (${batch.map(() => "?").join(",")})`;
      changed += countedMutation(this.db, "messages", where, batch, () =>
        this.db.run(`UPDATE messages SET status='done',outcome='pass',error=NULL,updated_at=? WHERE ${where}`, [Date.now(), ...batch]));
    }
    this.emit(); return changed;
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
    this.emit();
    return rows.map((row) => toMessage({ ...row, status: "running", updated_at: now }));
  }

  /** Mark messages done (success) or failed (terminal). `outcome` records the
   *  agent's result for a `done` batch (ok / pass / error) so the UI shows
   *  what actually happened, not just that the run finished. */
  complete(
    ids: string[],
    status: "done" | "failed",
    error: string | null = null,
    outcome: QueueOutcomeResult | null = null,
  ): void {
    if (ids.length === 0) {
      return;
    }
    const now = Date.now();
    const placeholders = ids.map(() => "?").join(",");
    this.db.run(
      `UPDATE messages SET status = ?, outcome = ?, error = ?, updated_at = ? WHERE id IN (${placeholders})`,
      [status, outcome, error, now, ...ids],
    );
    this.emit();
  }

  /** A model-free inspection can return work without consuming either retry budget. */
  releaseClaim(ids: string[]): void {
    if (!ids.length) return;
    this.db.run(
      `UPDATE messages SET status = 'pending', updated_at = ?
       WHERE status = 'running' AND id IN (${ids.map(() => "?").join(",")})`,
      [Date.now(), ...ids],
    );
    this.emit();
  }

  /** Return claimed messages to `pending` with a `notBefore` in the future.
   *  Set countAttempt=false for capacity holds, which must not burn retries. */
  defer(ids: string[], notBefore: number, error: string | null = null, countAttempt = true): void {
    if (ids.length === 0) {
      return;
    }
    const now = Date.now();
    const placeholders = ids.map(() => "?").join(",");
    this.db.run(
      `UPDATE messages SET status = 'pending', not_before = ?, attempts = attempts + ?,
         rate_limit_attempts = CASE WHEN ? THEN 0 ELSE rate_limit_attempts + 1 END, error = ?, updated_at = ?
         WHERE id IN (${placeholders})`,
      [notBefore, countAttempt ? 1 : 0, countAttempt ? 1 : 0, error, now, ...ids],
    );
    this.emit();
  }

  /**
   * Re-arm finished messages for another run: reset rows back to `pending` with
   * attempts/backoff/outcome/error cleared, so the next drain (every ~3s)
   * replays them — the per-thread coalescing then resumes the routine's session
   * as usual.
   *
   * With explicit `ids`, replays those messages whether they're `failed` or
   * `done` (so a specific delivery can be re-run on demand). With no ids, bulk
   * re-arms every `failed` message — the "retry all the failures" path. Never
   * touches `pending`/`running` rows. Returns the number re-armed.
   */
  requeue(ids?: string[]): number {
    const now = Date.now();
    const set =
      "SET status = 'pending', attempts = 0, rate_limit_attempts = 0, not_before = 0, outcome = NULL, error = NULL, updated_at = ?";
    const where = ids?.length
      ? `id IN (${ids.map(() => "?").join(",")}) AND status IN ('failed', 'done')`
      : "status = 'failed'";
    const count = countedMutation(this.db, "messages", where, ids?.length ? ids : [], () =>
      this.db.run(`UPDATE messages ${set} WHERE ${where}`, [now, ...(ids?.length ? ids : [])]));
    if (count) this.emit();
    return count;
  }

  /** Recover claimed work after a restart. */
  requeueStuckRunning(): number {
    const count = countedMutation(this.db, "messages", "status = 'running'", [], () =>
      this.db.run("UPDATE messages SET status = 'pending', updated_at = ? WHERE status = 'running'", [Date.now()]));
    if (count) this.emit();
    return count;
  }

  /** Ready work ordered by eligibility time; retrying work rejoins at its defer time. */
  readyThreads(now: number = Date.now()): HookDrainThread[] {
    return this.db
      .query<{ thread_id: string; job_name: string; latest_pr_update_at: number; preflight_version: string }, [number]>(
        `SELECT thread_id, job_name, MAX(CASE WHEN event = 'pull_request' THEN enqueued_at ELSE 0 END) AS latest_pr_update_at,
         MAX(enqueued_at) || ':' || COUNT(*) || ':' || MAX(not_before) AS preflight_version FROM messages
         WHERE status = 'pending' AND not_before <= ?
         GROUP BY thread_id
         ORDER BY MIN(MAX(enqueued_at, not_before)), thread_id`,
      )
      .all(now)
      .map((r) => ({ threadId: r.thread_id, jobName: r.job_name, latestPrUpdateAt: r.latest_pr_update_at, preflightVersion: r.preflight_version }));
  }

  readyThreadIds(now: number = Date.now()): string[] {
    return this.readyThreads(now).map((thread) => thread.threadId);
  }

  /**
   * Newest row per thread_id, newest-first, capped at `limit` *threads*.
   *
   * A flood of many rows for one thread (e.g. a routine that produces hundreds
   * of deliveries for a single PR) is collapsed to one row and cannot crowd
   * other subjects out of the sidebar window — solving the blink bug.
   *
   * Picks each thread's representative via a correlated subquery that orders by
   * (updated_at, rowid) DESC and takes the top row — a SINGLE real row. We can't
   * join on per-column MAX()es (MAX(updated_at) and MAX(rowid) can come from
   * DIFFERENT rows once an older row's updated_at is bumped by claim/complete/
   * defer, and then no row matches all the maxes and the thread vanishes).
   */
  listLatestPerThread(limit = 500, includePayload = true): QueuedMessage[] {
    return this.db
      .query<Row, [number]>(
        `SELECT ${columns(includePayload, "m")}
         FROM messages m JOIN ${storageTable(this.db, "messages")} physical ON physical.id = m.id
         WHERE physical.rowid = (
           SELECT m2.rowid FROM ${storageTable(this.db, "messages")} m2
           WHERE m2.thread_id = m.thread_id
           ORDER BY m2.updated_at DESC, m2.rowid DESC
           LIMIT 1
         )
         ORDER BY physical.updated_at DESC, physical.rowid DESC
         LIMIT ?`,
      )
      .all(limit)
      .map(toMessage);
  }

  /** List messages for inspection / the UI. Optionally filter by status or
   *  thread. Newest-first. */
  list(
    opts: {
      status?: QueueStatus;
      threadId?: string;
      limit?: number;
      includePayload?: boolean;
    } = {},
  ): QueuedMessage[] {
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
        `SELECT ${columns(opts.includePayload !== false)} FROM messages ${clause} ORDER BY enqueued_at DESC LIMIT ?`,
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
    const where = "status IN ('done', 'failed') AND updated_at < ?";
    return countedMutation(this.db, "messages", where, [cutoff], () =>
      this.db.run(`DELETE FROM messages WHERE ${where}`, [cutoff]));
  }

  close(): void {
    this.db.close();
  }
}

let singleton: HookQueue | null = null;

/** Process-wide queue at the canonical PVC path. */
export function getHookQueue(): HookQueue {
  singleton ??= new HookQueue();
  return singleton;
}

export interface QueueOutcome {
  action: "done" | "defer" | "fail";
  /** For `defer`: epoch ms the batch becomes ready again. */
  notBefore?: number;
  error?: string;
}

/** Decide what to do with a just-run batch from the run result + limiter state.
 *  Pure so the retry/backoff/cap policy is unit-testable:
 *   - rate-limited (any)   → short Fibonacci backoff in seconds capped at 30s
 *                            (1,1,2,3,5,8,13,21,30…), does NOT burn a retry
 *   - clean exit 0         → done
 *   - else                 → exponential backoff up to `cap` attempts, then fail
 *
 *  A coalesced batch mixes messages with different attempt counts. We must NOT
 *  apply the OLDEST message's cap to brand-new work: a fresh delivery coalesced
 *  with one that already burned `cap` attempts would be failed after a single
 *  combined failure (P0-14). So the CAP check uses the MIN attempts in the batch
 *  (the freshest message still has retries left → the batch lives on), while the
 *  BACKOFF timing uses the MAX (back off as far as the most-tried message).
 */
export function nextQueueAction(opts: {
  exitCode: number | null;
  rateLimited: boolean;
  /** @deprecated Unused — rate-limit backoff is now the Fibonacci timer, not a
   *  wall-clock reset. Kept in the shape for back-compat with existing callers. */
  rateLimitResetAt: number;
  /** Highest `attempts` among the batch BEFORE this run — drives backoff. */
  priorAttempts: number;
  /** Capacity-only deferrals, separate from failure retries. */
  rateLimitAttempts?: number;
  /** Lowest `attempts` among the batch BEFORE this run — drives the cap check.
   *  Defaults to `priorAttempts` for single-message / legacy callers. */
  capAttempts?: number;
  cap: number;
  now: number;
  /**
   * True when a rate-limit message was detected but the module-level hold isn't
   * active (`!isRateLimited()`). Treated the same as `rateLimited` here — both
   * take the Fibonacci backoff — and kept as a distinct flag only so the recorded
   * error string can say "rate limited (no reset)". Does NOT burn the retry cap.
   */
  rateLimitTransient?: boolean;
}): QueueOutcome {
  if (opts.rateLimited || opts.rateLimitTransient) {
    // Rate limited — defer on a SHORT Fibonacci timer (1,1,2,3,5,8,13,21,30s
    // capped at 30s), based on how many times this batch has already tried.
    // Does NOT burn the retry cap: a rate limit is not the work's fault.
    const backoffMs = fibBackoffMs((opts.rateLimitAttempts ?? opts.priorAttempts) + 1);
    return {
      action: "defer",
      notBefore: opts.now + backoffMs,
      error: opts.rateLimited ? "rate limited" : "rate limited (no reset)",
    };
  }
  if (opts.exitCode === 0) {
    return { action: "done" };
  }
  // Cap check on the FRESHEST message (min attempts): the batch only fails once
  // every message in it has exhausted its own retries.
  const capAttempt = (opts.capAttempts ?? opts.priorAttempts) + 1;
  if (capAttempt > opts.cap) {
    return { action: "fail", error: `exhausted ${opts.cap} retries` };
  }
  // Backoff timing on the MOST-tried message (max attempts).
  const backoffAttempt = opts.priorAttempts + 1;
  const backoffMs = Math.min(60_000 * 2 ** (backoffAttempt - 1), 30 * 60_000);
  return {
    action: "defer",
    notBefore: opts.now + backoffMs,
    error: `exit ${opts.exitCode ?? "?"}`,
  };
}
