/**
 * Persistent per-Sentry-issue "have we triaged this before?" state.
 *
 * The triage routine (first-seen filter) wants to run Claude EXACTLY ONCE per
 * Sentry issue — when the issue is first observed — and stay quiet on every
 * re-occurrence (re-alerts of an already-seen issue burn usage for no new
 * signal). The 24h delivery dedup in `deliveries.ts` only dedups identical
 * delivery ids; an issue that re-fires under a new delivery id sails past it.
 * This store is the durable per-issue-id ledger that gates "is this the FIRST
 * time we've seen issue X?".
 *
 * Modeled on `deliveries.ts`: a small WAL SQLite file under the state dir,
 * opened once at boot via `initSentrySeenStore()`. Its own DB file so the
 * issue ledger (long-lived) and the delivery ring (short-lived) stay decoupled.
 *
 * The atomic `INSERT ... ON CONFLICT DO NOTHING` in `markIssueSeen` IS the
 * singleflight for a thundering herd: when a burst of events for one new issue
 * races, exactly ONE caller's insert lands (`firstSeen: true`); the rest see
 * the row already present (`firstSeen: false`).
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";

const DEFAULT_DB_PATH = join(process.cwd(), ".claude", "errandd", "sentry-seen.db");

/** 90 days. Issues are long-lived; an issue that re-appears after months of
 *  silence SHOULD re-triage, so the prune window is generous. */
export const DEFAULT_SENTRY_SEEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

let db: Database | null = null;

/** Open the durable first-seen store. Called once by the daemon at boot.
 *  Idempotent. Tests pass an explicit path (e.g. a tmp file). */
export function initSentrySeenStore(path: string = DEFAULT_DB_PATH): void {
  if (db) {
    return;
  }
  db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.run(`
    CREATE TABLE IF NOT EXISTS sentry_seen (
      issue_id      TEXT PRIMARY KEY,
      first_seen_at INTEGER NOT NULL
    )
  `);
}

/** Test-only: drop the in-memory handle + close the DB (simulates a restart). */
export function __resetSentrySeenStoreForTests(): void {
  db?.close();
  db = null;
}

/**
 * Atomically record that we've now seen `issueId`. Returns `firstSeen: true`
 * IFF this call inserted the row — i.e. this is the FIRST observation of the
 * issue. A concurrent burst for the same new issue yields exactly one
 * `firstSeen: true` (the insert that won the `ON CONFLICT DO NOTHING` race);
 * every other call gets `firstSeen: false`.
 *
 * An empty/missing issue id is NOT a real issue identity, so it's never
 * recorded and always returns `firstSeen: false` — the dispatch path treats a
 * payload with no issue id as "can't dedup" and lets it through rather than
 * mistaking it for a brand-new issue.
 *
 * Fails OPEN when the store wasn't initialized (returns `firstSeen: true`): a
 * missing ledger should never silently suppress a triage.
 */
export function markIssueSeen(issueId: string): { firstSeen: boolean } {
  if (!issueId) {
    return { firstSeen: false };
  }
  if (!db) {
    return { firstSeen: true };
  }
  const res = db.run(
    `INSERT INTO sentry_seen (issue_id, first_seen_at) VALUES (?, ?)
       ON CONFLICT(issue_id) DO NOTHING`,
    [issueId, Date.now()],
  );
  return { firstSeen: res.changes > 0 };
}

/** Read-only: have we recorded this issue before? Empty id / uninitialized
 *  store → false. */
export function hasSeenIssue(issueId: string): boolean {
  if (!issueId || !db) {
    return false;
  }
  const row = db
    .query<{ issue_id: string }, [string]>("SELECT issue_id FROM sentry_seen WHERE issue_id = ?")
    .get(issueId);
  return row != null;
}

/** Drop issue rows older than `ttlMs` so a long-silent issue re-triages if it
 *  ever comes back. Returns the number of rows pruned. No-op when uninitialized. */
export function pruneSentrySeen(ttlMs: number = DEFAULT_SENTRY_SEEN_TTL_MS): number {
  if (!db) {
    return 0;
  }
  const cutoff = Date.now() - ttlMs;
  const res = db.run("DELETE FROM sentry_seen WHERE first_seen_at < ?", [cutoff]);
  return res.changes;
}
