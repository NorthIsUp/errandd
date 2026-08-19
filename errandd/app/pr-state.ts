/**
 * Per-PR git-state store, fed by the GitHub webhook hook pipeline.
 *
 * `dispatchHook` (app/hooks/github.ts) calls `recordPrStateFromWebhook` on every
 * `pull_request` event, regardless of whether any routine subscribes — so the
 * daemon accumulates the live open/merged/closed/conflicted state of every PR it
 * hears about. The sidebar reads it via GET /api/prs/open and renders a per-PR
 * icon.
 *
 * Write-through to a small WAL SQLite file (opened at boot by
 * `initPrStateStore()`, modeled on `hooks/deliveries.ts`) and hydrated from it
 * on start, so state survives the ~10min auto-update restarts. That matters
 * most for terminal states: the poller only lists `--state open`, so before the
 * cache a restart re-rendered every merged/closed PR as "unknown" until the
 * GraphQL backfill (app/pr-backfill.ts) paid to re-resolve it. Best-effort —
 * with no store initialized (tests) this stays pure in-memory.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { derivePrState, type PrGitState, type PrStateInfo } from "../shared/prState";

interface PrStateEntry extends PrStateInfo {
  /** Date.now() of the last event that updated this entry. */
  updatedAt: number;
}

/** repo#number → latest known state. */
const store = new Map<string, PrStateEntry>();

const DEFAULT_DB_PATH = join(process.cwd(), ".claude", "errandd", "pr-state.db");

/** Rows older than this are dropped at boot. Long enough that a PR merged
 *  before a holiday still renders its icon on return; short enough that the
 *  file stays small. */
const PRUNE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let db: Database | null = null;

interface PrStateRow {
  key: string;
  state: string;
  mergeable: number | null;
  updated_at: number;
}

/** Open the durable store and hydrate the map from it. Called once by the
 *  daemon at boot; idempotent. Tests pass an explicit path (e.g. a tmp file). */
export function initPrStateStore(path: string = DEFAULT_DB_PATH): void {
  if (db) {
    return;
  }
  db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.run(`
    CREATE TABLE IF NOT EXISTS pr_state (
      key        TEXT PRIMARY KEY,
      state      TEXT NOT NULL,
      mergeable  INTEGER,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run("DELETE FROM pr_state WHERE updated_at < ?", [Date.now() - PRUNE_TTL_MS]);
  for (const row of db.query<PrStateRow, []>("SELECT * FROM pr_state").all()) {
    // A live in-memory entry is newer than anything on disk — don't clobber it.
    if (!store.has(row.key)) {
      store.set(row.key, {
        state: row.state as PrGitState,
        mergeable: row.mergeable === null ? null : row.mergeable === 1,
        updatedAt: row.updated_at,
      });
    }
  }
}

/** Store one entry in memory and write it through to SQLite. Persistence never
 *  throws — a broken DB file degrades to in-memory. */
function put(key: string, entry: PrStateEntry): void {
  store.set(key, entry);
  if (!db) {
    return;
  }
  try {
    db.run(
      `INSERT INTO pr_state (key, state, mergeable, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           state = excluded.state,
           mergeable = excluded.mergeable,
           updated_at = excluded.updated_at`,
      [key, entry.state, entry.mergeable === null ? null : entry.mergeable ? 1 : 0, entry.updatedAt],
    );
  } catch {
    // best-effort — persistence must not break the live webhook path
  }
}

/** Canonical store key — matches the sidebar's TreeItem key (`repo#num`). */
export function prStateKey(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`;
}

/** Read `repository.full_name` (or owner/name) + PR number from a webhook body. */
function readPrIdentity(payload: unknown): { repo: string; prNumber: number } | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const root = payload as Record<string, unknown>;
  const pr = root.pull_request;
  const repoObj = root.repository;
  if (typeof pr !== "object" || pr === null || typeof repoObj !== "object" || repoObj === null) {
    return null;
  }
  const prObj = pr as Record<string, unknown>;
  const repoR = repoObj as Record<string, unknown>;

  const num = typeof prObj.number === "number" ? prObj.number : Number(prObj.number);
  if (!Number.isFinite(num)) {
    return null;
  }

  let repo: string | null = typeof repoR.full_name === "string" ? repoR.full_name : null;
  if (!repo) {
    const owner = repoR.owner;
    const ownerLogin =
      typeof owner === "object" && owner !== null
        ? (owner as Record<string, unknown>).login
        : undefined;
    if (typeof ownerLogin === "string" && typeof repoR.name === "string") {
      repo = `${ownerLogin}/${repoR.name}`;
    }
  }
  if (!repo?.includes("/")) {
    return null;
  }
  return { repo, prNumber: num };
}

/**
 * Record PR git-state from a `pull_request` webhook payload. Never throws.
 *
 * An event we can't classify (`derivePrState` → "unknown") does NOT clobber a
 * previously-known state — a `labeled`/`edited` event with no mergeability info
 * shouldn't wipe a known "conflicted". Returns the stored entry (or the retained
 * prior one), or null when the payload isn't a usable PR event.
 */
export function recordPrStateFromWebhook(payload: unknown): PrStateInfo | null {
  const ident = readPrIdentity(payload);
  if (!ident) {
    return null;
  }
  const prObj = (payload as Record<string, unknown>).pull_request as Record<string, unknown>;
  const key = prStateKey(ident.repo, ident.prNumber);
  const derived: PrGitState = derivePrState(prObj);
  if (derived === "unknown") {
    return store.get(key) ?? null;
  }
  const mergeable = typeof prObj.mergeable === "boolean" ? prObj.mergeable : null;
  const entry: PrStateEntry = { state: derived, mergeable, updatedAt: Date.now() };
  put(key, entry);
  return { state: entry.state, mergeable: entry.mergeable };
}

/** Record a state resolved outside the webhook path (see app/pr-backfill.ts). */
export function recordPrState(repo: string, prNumber: number, info: PrStateInfo): void {
  put(prStateKey(repo, prNumber), { ...info, updatedAt: Date.now() });
}

/** Latest known state for a `repo#number` key, or null when we've never seen it. */
export function getPrState(key: string): PrStateInfo | null {
  const entry = store.get(key);
  return entry ? { state: entry.state, mergeable: entry.mergeable } : null;
}

/** Snapshot of all known PR states keyed by `repo#number`, for the API. */
export function getPrStates(): Record<string, PrStateInfo> {
  const out: Record<string, PrStateInfo> = {};
  for (const [key, entry] of store) {
    out[key] = { state: entry.state, mergeable: entry.mergeable };
  }
  return out;
}

/** Test-only: clear the store + close the DB (simulates a daemon restart). */
export function __resetPrStatesForTest(): void {
  store.clear();
  db?.close();
  db = null;
}
