/**
 * Durable interactive-message queue (SQLite, on the PVC).
 *
 * When Claude is rate-limited, an inbound Telegram/Discord/Slack message would
 * otherwise be answered with "Usage limit reached…" and DROPPED. Instead we
 * enqueue it here and reply once ("Queued — I'll respond after the limit resets
 * at HH:MM UTC."). A daemon tick drains the queue the moment `isRateLimited()`
 * clears: for each item it re-runs `runUserMessage` and sends the reply back to
 * the stored chat on the right platform.
 *
 * Mirrors hookQueue.ts: a single daemon process owns the DB, the file lives on
 * the PVC so a restart (e.g. the ~10-min auto-update) replays instead of losing
 * messages, and `requeueStuckRunning()` recovers any item left mid-drain.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";

const DB_PATH = join(process.cwd(), ".claude", "errandd", "interactive-queue.db");

export type InteractivePlatform = "telegram" | "discord" | "slack";
export type InteractiveStatus = "pending" | "running" | "done" | "failed";

/**
 * One queued interactive message. `chatId` is the platform-native destination
 * the reply is routed back to:
 *   - telegram: numeric chat id (stored as string)   + optional `threadTs` =
 *               the forum/topic `message_thread_id` (also numeric-as-string).
 *   - discord:  the user id (DMs) — replies go via sendMessageToUser.
 *   - slack:    the channel id                        + optional `threadTs` =
 *               the Slack `thread_ts`.
 * `userId` is the sender (for the prompt prefix / audit). `sessionKey` is the
 * per-thread session id the original handler computed, so the drained run
 * resumes the SAME Claude conversation the user was talking to.
 */
export interface InteractiveMessage {
  id: string;
  platform: InteractivePlatform;
  chatId: string;
  threadTs: string | null;
  userId: string | null;
  /** Per-thread session key (telegram sessionKey / discord channelId / slack
   *  slk:… id), so the drained run resumes the right conversation. */
  sessionKey: string | null;
  /** Agent name for thread-scoped runs (discord/slack thread sessions). */
  agentName: string | null;
  /** Fully built prompt (already prefixed/wrapped by the platform handler). */
  text: string;
  enqueuedAt: number;
  status: InteractiveStatus;
  attempts: number;
  notBefore: number;
  error: string | null;
  updatedAt: number;
}

export interface EnqueueInteractiveInput {
  id?: string;
  platform: InteractivePlatform;
  chatId: string;
  threadTs?: string | null;
  userId?: string | null;
  sessionKey?: string | null;
  agentName?: string | null;
  text: string;
  enqueuedAt?: number;
}

interface Row {
  id: string;
  platform: string;
  chat_id: string;
  thread_ts: string | null;
  user_id: string | null;
  session_key: string | null;
  agent_name: string | null;
  text: string;
  enqueued_at: number;
  status: InteractiveStatus;
  attempts: number;
  not_before: number;
  error: string | null;
  updated_at: number;
}

function toMessage(r: Row): InteractiveMessage {
  return {
    id: r.id,
    platform: r.platform as InteractivePlatform,
    chatId: r.chat_id,
    threadTs: r.thread_ts,
    userId: r.user_id,
    sessionKey: r.session_key,
    agentName: r.agent_name,
    text: r.text,
    enqueuedAt: r.enqueued_at,
    status: r.status,
    attempts: r.attempts,
    notBefore: r.not_before,
    error: r.error,
    updatedAt: r.updated_at,
  };
}

let _counter = 0;
function generateId(platform: string): string {
  return `${platform}-${Date.now().toString(36)}-${(_counter++).toString(36)}`;
}

export class InteractiveQueue {
  private db: Database;

  constructor(path: string = DB_PATH) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS interactive (
        id          TEXT PRIMARY KEY,
        platform    TEXT NOT NULL,
        chat_id     TEXT NOT NULL,
        thread_ts   TEXT,
        user_id     TEXT,
        session_key TEXT,
        agent_name  TEXT,
        text        TEXT NOT NULL,
        enqueued_at INTEGER NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        attempts    INTEGER NOT NULL DEFAULT 0,
        not_before  INTEGER NOT NULL DEFAULT 0,
        error       TEXT,
        updated_at  INTEGER NOT NULL
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_interactive_status ON interactive(status, not_before, enqueued_at)",
    );
  }

  /** Enqueue an interactive message. Returns the assigned id. */
  enqueue(input: EnqueueInteractiveInput): string {
    const now = input.enqueuedAt ?? Date.now();
    const id = input.id ?? generateId(input.platform);
    this.db.run(
      `INSERT OR IGNORE INTO interactive
         (id, platform, chat_id, thread_ts, user_id, session_key, agent_name, text, enqueued_at, status, attempts, not_before, error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, NULL, ?)`,
      [
        id,
        input.platform,
        input.chatId,
        input.threadTs ?? null,
        input.userId ?? null,
        input.sessionKey ?? null,
        input.agentName ?? null,
        input.text,
        now,
        now,
      ],
    );
    return id;
  }

  /** Claim ALL ready-pending messages (oldest-first), marking them `running`.
   *  The drain loop runs each and then marks done/failed. Returns [] when
   *  nothing is ready. */
  claimReady(now: number = Date.now(), limit = 100): InteractiveMessage[] {
    const rows = this.db
      .query<Row, [number, number]>(
        "SELECT * FROM interactive WHERE status = 'pending' AND not_before <= ? ORDER BY enqueued_at ASC LIMIT ?",
      )
      .all(now, limit);
    if (rows.length === 0) {
      return [];
    }
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    this.db.run(
      `UPDATE interactive SET status = 'running', updated_at = ? WHERE id IN (${placeholders})`,
      [now, ...ids],
    );
    return rows.map(toMessage);
  }

  /** Mark a message terminal (done = replied, failed = gave up). */
  complete(id: string, status: "done" | "failed", error: string | null = null): void {
    this.db.run("UPDATE interactive SET status = ?, error = ?, updated_at = ? WHERE id = ?", [
      status,
      error,
      Date.now(),
      id,
    ]);
  }

  /** Return a claimed message to `pending` with a future `notBefore` and a
   *  bumped attempt count — used to back off a transient failure. */
  defer(id: string, notBefore: number, error: string | null = null): void {
    this.db.run(
      "UPDATE interactive SET status = 'pending', not_before = ?, attempts = attempts + 1, error = ?, updated_at = ? WHERE id = ?",
      [notBefore, error, Date.now(), id],
    );
  }

  /** Recover from a crash/restart: any message left `running` (its drainer died
   *  mid-run) is reset to `pending` so it replays. Call once on boot. */
  requeueStuckRunning(): number {
    return this.db.run(
      "UPDATE interactive SET status = 'pending', updated_at = ? WHERE status = 'running'",
      [Date.now()],
    ).changes;
  }

  /** Count ready-pending messages (for the daemon to decide whether to drain). */
  pendingCount(now: number = Date.now()): number {
    return (
      this.db
        .query<{ n: number }, [number]>(
          "SELECT COUNT(*) AS n FROM interactive WHERE status = 'pending' AND not_before <= ?",
        )
        .get(now)?.n ?? 0
    );
  }

  /** List messages for inspection. Newest-first. */
  list(opts: { status?: InteractiveStatus; limit?: number } = {}): InteractiveMessage[] {
    const args: (string | number)[] = [];
    let clause = "";
    if (opts.status) {
      clause = "WHERE status = ?";
      args.push(opts.status);
    }
    const limit = opts.limit ?? 500;
    args.push(limit);
    return this.db
      .query<Row, (string | number)[]>(
        `SELECT * FROM interactive ${clause} ORDER BY enqueued_at DESC LIMIT ?`,
      )
      .all(...args)
      .map(toMessage);
  }

  /** Drop terminal (done/failed) rows older than ttl, keeping the DB small. */
  prune(ttlMs: number, now: number = Date.now()): number {
    return this.db.run(
      "DELETE FROM interactive WHERE status IN ('done', 'failed') AND updated_at < ?",
      [now - ttlMs],
    ).changes;
  }

  close(): void {
    this.db.close();
  }
}

let singleton: InteractiveQueue | null = null;

/** Process-wide interactive queue at the canonical PVC path. */
export function getInteractiveQueue(): InteractiveQueue {
  singleton ??= new InteractiveQueue();
  return singleton;
}

/** Format the "Queued — I'll respond after the limit resets at HH:MM UTC."
 *  user-facing reply. Shared by all three platform handlers so the wording is
 *  identical. */
export function queuedReply(resetAt: number): string {
  const resetStr = new Date(resetAt).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `Queued — I'll respond after the limit resets at ${resetStr} UTC.`;
}
