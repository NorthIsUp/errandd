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
import type { Database } from "bun:sqlite";
import { openDatabase } from "./sqlite";
import { join } from "node:path";
import {
  derivePrState,
  type PrGitState,
  type PrStateInfo,
  type PrStateSnapshot,
} from "../shared/prState";

interface PrStateObservation extends PrStateInfo {
  /** Upstream updated_at/updatedAt, separate from local receipt retention. */
  sourceUpdatedAtMs?: number | null;
}

interface PrStateEntry extends Required<PrStateObservation> {
  /** Date.now() of the last event that updated this entry. */
  updatedAt: number;
  revision: number;
}

/** repo#number → latest known state. */
const store = new Map<string, PrStateEntry>();
const subscribers = new Set<() => void>();
let revision = 0;
const epochMs = Date.now();

/** Capture before an asynchronous observation; only newer changes to that PR supersede it. */
export function getPrStateRevision(): number {
  return revision;
}

/** Deliver the current snapshot, then every semantic state change. */
export function subscribePrStates(listener: () => void): () => void {
  subscribers.add(listener);
  try {
    listener();
  } catch {
    /* Subscribers never interrupt webhook handling. */
  }
  return () => {
    subscribers.delete(listener);
  };
}

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
  source_updated_at_ms: number | null;
}

/** Open the durable store and hydrate the map from it. Called once by the
 *  daemon at boot; idempotent. Tests pass an explicit path (e.g. a tmp file). */
export function initPrStateStore(path: string = DEFAULT_DB_PATH): void {
  if (db) {
    return;
  }
  db = openDatabase(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.run(`
    CREATE TABLE IF NOT EXISTS pr_state (
      key        TEXT PRIMARY KEY,
      state      TEXT NOT NULL,
      mergeable  INTEGER,
      updated_at INTEGER NOT NULL,
      source_updated_at_ms INTEGER
    )
  `);
  if (
    !db
      .query<{ name: string }, []>("PRAGMA table_info(pr_state)")
      .all()
      .some((column) => column.name === "source_updated_at_ms")
  ) {
    db.exec("ALTER TABLE pr_state ADD COLUMN source_updated_at_ms INTEGER");
  }
  db.run("DELETE FROM pr_state WHERE updated_at < ?", [Date.now() - PRUNE_TTL_MS]);
  for (const row of db.query<PrStateRow, []>("SELECT * FROM pr_state").all()) {
    // A live in-memory entry is newer than anything on disk — don't clobber it.
    if (!store.has(row.key)) {
      store.set(row.key, {
        state: row.state as PrGitState,
        mergeable: row.mergeable === null ? null : row.mergeable === 1,
        updatedAt: row.updated_at,
        revision: ++revision,
        sourceUpdatedAtMs: row.source_updated_at_ms,
      });
    }
  }
}

/** Store one entry in memory and write it through to SQLite. Persistence never
 *  throws — a broken DB file degrades to in-memory. */
function put(key: string, observation: Omit<PrStateEntry, "revision">): PrStateEntry {
  const previous = store.get(key);
  // GitHub permits reopening closed PRs, but never merged ones.
  if (previous?.state === "merged" && observation.state !== "merged") return previous;
  const entry = { ...observation, revision: ++revision };
  store.set(key, entry);
  if (db) {
    try {
      db.run(
        `INSERT INTO pr_state (key, state, mergeable, updated_at, source_updated_at_ms) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             state = excluded.state,
             mergeable = excluded.mergeable,
             updated_at = excluded.updated_at,
             source_updated_at_ms = excluded.source_updated_at_ms`,
        [
          key,
          entry.state,
          entry.mergeable === null ? null : entry.mergeable ? 1 : 0,
          entry.updatedAt,
          entry.sourceUpdatedAtMs,
        ],
      );
    } catch {
      // Persistence must not break webhook handling or live publication.
    }
  }
  return entry;
}

function commitPrStates(
  observations: { key: string; observation: PrStateObservation }[],
  startedRevision: number,
): void {
  let changed = false;
  for (const { key, observation } of observations) {
    const { sourceUpdatedAtMs = null, ...info } = observation;
    const previous = store.get(key);
    const sourceOrder =
      sourceUpdatedAtMs != null && previous?.sourceUpdatedAtMs != null
        ? sourceUpdatedAtMs - previous.sourceUpdatedAtMs
        : null;
    if (sourceOrder !== null && sourceOrder < 0) continue;
    if ((sourceOrder === null || sourceOrder === 0) && (previous?.revision ?? 0) > startedRevision)
      continue;
    if (previous?.sourceUpdatedAtMs != null) {
      // Unversioned observations cannot undo versioned evidence; merged is irreversible.
      if (sourceUpdatedAtMs === null && info.state !== "merged") continue;
    }
    const stored = put(key, {
      ...info,
      updatedAt: Date.now(),
      sourceUpdatedAtMs: sourceUpdatedAtMs ?? previous?.sourceUpdatedAtMs ?? null,
    });
    changed ||= previous?.state !== stored.state || previous?.mergeable !== stored.mergeable;
  }
  if (!changed) return;
  for (const listener of subscribers) {
    try {
      listener();
    } catch {
      /* One disconnected consumer cannot block another. */
    }
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
  recordPrState(ident.repo, ident.prNumber, {
    state: derived,
    mergeable,
    sourceUpdatedAtMs: prSourceUpdatedAtMs(prObj.updated_at),
  });
  return getPrState(key);
}

/** Provider timestamps may be absent in legacy data; never substitute receipt time. */
export function prSourceUpdatedAtMs(value: unknown): number | null {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** Commit an observation unless this PR changed after its fetch began. */
export function recordPrState(
  repo: string,
  prNumber: number,
  observation: PrStateObservation,
  startedRevision = revision,
): void {
  commitPrStates([{ key: prStateKey(repo, prNumber), observation }], startedRevision);
}

/** Apply one complete open-list batch, preserving conflict evidence and publishing once. */
export function recordOpenPrStates(
  prs: readonly { repo: string; number: number; isDraft: boolean; updatedAt?: string }[],
  startedRevision: number,
): void {
  commitPrStates(
    prs.map((pr) => {
      const key = prStateKey(pr.repo, pr.number);
      const current = getPrState(key);
      const mergeable =
        current && current.state !== "closed" && current.state !== "merged"
          ? current.mergeable
          : null;
      const observation: PrStateObservation = {
        state: pr.isDraft ? "draft" : current?.state === "conflicted" ? "conflicted" : "open",
        mergeable,
        sourceUpdatedAtMs: prSourceUpdatedAtMs(pr.updatedAt),
      };
      return { key, observation };
    }),
    startedRevision,
  );
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

/** Synchronous accessor: one canonical version accompanies the complete entity state. */
export function getPrStateSnapshot(): PrStateSnapshot {
  return { states: getPrStates(), stateVersion: { epochMs, revision } };
}

/** Test-only: clear the store + close the DB (simulates a daemon restart). */
export function __resetPrStatesForTest(): void {
  store.clear();
  revision = 0;
  subscribers.clear();
  db?.close();
  db = null;
}
