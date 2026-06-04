/**
 * In-memory ring buffer of recently received GitHub webhook deliveries.
 *
 * Lost on daemon restart by design — this is a "what's hitting me right now?"
 * debugging surface, not a durable audit log. The durable hook queue
 * (`hookQueue.ts`) is the persistent path; this is the inspection surface.
 *
 * The delivery shape is shared with the web app — see shared/deliveryTypes.ts.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type {
  DeliveryBase,
  DeliveryField,
  DeliveryKeys,
  DeliveryRoutine,
  DeliverySource,
} from "../../shared/deliveryTypes";

export type {
  DeliveryBase,
  DeliveryField,
  DeliveryKeys,
  DeliveryRoutine,
  DeliverySource,
  DeliveryStatus,
} from "../../shared/deliveryTypes";

/** The daemon's delivery: the shared wire shape plus the full parsed `payload`,
 *  kept in memory only (omitted from the list/SSE responses; fetched lazily). */
export interface Delivery extends DeliveryBase {
  payload?: unknown;
}

/** Map an event name to its provider. `sentry:…` / `datadog:…` carry a
 *  prefix; everything else is a GitHub event. */
export function deliverySourceFromEvent(event: string): DeliverySource {
  if (event.startsWith("sentry:")) {
    return "sentry";
  }
  if (event.startsWith("datadog:")) {
    return "datadog";
  }
  return "github";
}

const MAX_DELIVERIES = 50;
/** Long enough to catch GitHub's typical retry window; not so long that it
 *  bloats memory. */
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

const ring: Delivery[] = [];
const dedup = new Map<string, number>(); // id → receivedAt

// Real-time fan-out: the web UI's deliveries tab subscribes over SSE and gets
// pushed each delivery as it's recorded, evaluated, or annotated.
type DeliveryListener = (d: Delivery) => void;
const listeners = new Set<DeliveryListener>();

/** Subscribe to delivery changes (new / evaluated / skip-annotated). Returns
 *  an unsubscribe function. The callback receives the (mutated) ring entry. */
export function subscribeDeliveries(fn: DeliveryListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(d: Delivery): void {
  for (const fn of listeners) {
    try {
      fn(d);
    } catch {
      // a slow/broken SSE consumer must not break delivery recording
    }
  }
}

// --- Durable persistence (opt-in) ---------------------------------------------
// The ring is in-memory, so a daemon restart (every ~10min via auto-update)
// empties the Deliveries tab until new hooks arrive. When the daemon calls
// initDeliveryStore() at boot we write each delivery through to SQLite and
// hydrate the ring from it on start — so the tab shows the recent N across
// restarts (and dedup survives too). Tests never init → pure in-memory.
const DEFAULT_DB_PATH = join(process.cwd(), ".claude", "clawdcode", "deliveries.db");
const KEEP_ROWS = 500;
let db: Database | null = null;

interface DRow {
  id: string;
  event: string;
  received_at: number;
  summary: string;
  status: string;
  source: string | null;
  pk: string | null;
  keys: string | null;
  fields: string | null;
  routines: string | null;
  payload_snippet: string;
  payload: string | null;
}

function rowToDelivery(r: DRow): Delivery {
  const parse = <T>(s: string | null): T | undefined => {
    if (s == null) {
      return undefined;
    }
    try {
      return JSON.parse(s) as T;
    } catch {
      return undefined;
    }
  };
  return {
    id: r.id,
    event: r.event,
    receivedAt: r.received_at,
    summary: r.summary,
    status: r.status as Delivery["status"],
    matched: [],
    payloadSnippet: r.payload_snippet,
    source: (r.source as DeliverySource | null) ?? undefined,
    pk: r.pk ?? undefined,
    keys: parse<DeliveryKeys>(r.keys),
    fields: parse<DeliveryField[]>(r.fields),
    routines: parse<DeliveryRoutine[]>(r.routines),
    payload: parse<unknown>(r.payload),
  };
}

function persist(d: Delivery): void {
  if (!db) {
    return;
  }
  try {
    db.run(
      `INSERT OR REPLACE INTO deliveries
         (id, event, received_at, summary, status, source, pk, keys, fields, routines, payload_snippet, payload, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        d.id,
        d.event,
        d.receivedAt,
        d.summary,
        d.status,
        d.source ?? null,
        d.pk ?? null,
        d.keys ? JSON.stringify(d.keys) : null,
        d.fields ? JSON.stringify(d.fields) : null,
        d.routines ? JSON.stringify(d.routines) : null,
        d.payloadSnippet,
        d.payload === undefined ? null : JSON.stringify(d.payload),
        Date.now(),
      ],
    );
  } catch {
    // persistence is best-effort — never break the live path
  }
}

/** Open the durable store + hydrate the ring/dedup from recent rows. Called
 *  once by the daemon at boot. Idempotent. */
export function initDeliveryStore(path: string = DEFAULT_DB_PATH): void {
  if (db) {
    return;
  }
  db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.run(`
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, event TEXT NOT NULL, received_at INTEGER NOT NULL,
      summary TEXT NOT NULL, status TEXT NOT NULL, source TEXT, pk TEXT,
      keys TEXT, fields TEXT, routines TEXT, payload_snippet TEXT NOT NULL,
      payload TEXT, updated_at INTEGER NOT NULL
    )
  `);
  // Trim to the most recent KEEP_ROWS so the file stays bounded.
  db.run(
    `DELETE FROM deliveries WHERE id NOT IN (
       SELECT id FROM deliveries ORDER BY received_at DESC LIMIT ?
     )`,
    [KEEP_ROWS],
  );
  // Hydrate the in-memory ring (newest first) + dedup window.
  const rows = db
    .query<DRow, [number]>("SELECT * FROM deliveries ORDER BY received_at DESC LIMIT ?")
    .all(MAX_DELIVERIES);
  const now = Date.now();
  for (let i = rows.length - 1; i >= 0; i--) {
    const d = rowToDelivery(rows[i]);
    ring.unshift(d);
    if (now - d.receivedAt < DEDUP_TTL_MS) {
      dedup.set(d.id, d.receivedAt);
    }
  }
  while (ring.length > MAX_DELIVERIES) {
    ring.pop();
  }
}

/** Test-only: drop the in-memory state + close the DB (simulates a restart). */
export function __resetDeliveryStoreForTests(): void {
  ring.length = 0;
  dedup.clear();
  db?.close();
  db = null;
}

/** A delivery stripped of its full `payload` — what goes over the wire in the
 *  list + SSE responses (the payload is fetched lazily per-id). */
export function deliveryForWire(d: Delivery): Delivery {
  const { payload: _payload, ...rest } = d;
  return rest;
}

/** Append a delivery to the ring. Returns true if this is the first time
 *  we've seen this delivery id within the dedup window. */
export function recordDelivery(d: Delivery): boolean {
  const now = Date.now();
  pruneDedup(now);

  const seen = dedup.has(d.id);
  dedup.set(d.id, now);

  // Normalize the enrichment fields so every consumer sees a stable shape.
  d.source ??= deliverySourceFromEvent(d.event);
  d.fields ??= [];
  d.routines ??= [];

  ring.unshift(d);
  while (ring.length > MAX_DELIVERIES) {
    ring.pop();
  }
  emit(d);
  persist(d);
  return !seen;
}

export function recentDeliveries(): Delivery[] {
  return ring.slice();
}

/** Attach the matcher's evaluation (extracted fields + per-routine
 *  trigger/skip) to an in-ring delivery, then push the update to subscribers.
 *  Best-effort — a no-op if the delivery has aged out (e.g. on reprocess). */
export function setDeliveryEvaluation(
  id: string,
  evaluation: {
    source?: DeliverySource;
    pk?: string;
    keys?: DeliveryKeys;
    fields?: DeliveryField[];
    routines?: DeliveryRoutine[];
  },
): void {
  const d = ring.find((x) => x.id === id);
  if (!d) {
    return;
  }
  if (evaluation.source) {
    d.source = evaluation.source;
  }
  if (evaluation.pk !== undefined) {
    d.pk = evaluation.pk;
  }
  if (evaluation.keys) {
    d.keys = evaluation.keys;
  }
  if (evaluation.fields) {
    d.fields = evaluation.fields;
  }
  if (evaluation.routines) {
    d.routines = evaluation.routines;
  }
  emit(d);
  persist(d);
}

/** Stash the full parsed payload on the in-ring delivery so the UI can fetch
 *  and prettify it on demand. Best-effort. */
export function attachDeliveryPayload(id: string, payload: unknown): void {
  const d = ring.find((x) => x.id === id);
  if (d) {
    d.payload = payload;
    persist(d);
  }
}

/** The full parsed payload for a delivery id, or null if unknown. Checks the
 *  in-memory ring first, then the durable store (so payloads survive restart). */
export function getDeliveryPayload(id: string): { event: string; payload: unknown } | null {
  const d = ring.find((x) => x.id === id);
  if (d && d.payload !== undefined) {
    return { event: d.event, payload: d.payload };
  }
  if (db) {
    const row = db
      .query<{ event: string; payload: string | null }, [string]>(
        "SELECT event, payload FROM deliveries WHERE id = ?",
      )
      .get(id);
    if (row?.payload != null) {
      try {
        return { event: row.event, payload: JSON.parse(row.payload) };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Append a "static skip" note to an existing delivery's summary. Called
 * from the matcher path when the daemon decides not to spawn Claude for
 * a delivery (bot user, PR targets main, etc.). Best-effort — if the
 * delivery has aged out of the ring, the call is a no-op.
 */
export function annotateSkip(deliveryId: string, jobName: string, reason: string): void {
  for (const d of ring) {
    if (d.id !== deliveryId) {
      continue;
    }
    const note = `skip ${jobName}: ${reason}`;
    // Don't double-append the exact same note if multiple jobs share a
    // skip reason — the ring is small enough that a substring check is
    // fine and keeps the summary readable.
    if (d.summary.includes(note)) {
      return;
    }
    d.summary = d.summary ? `${d.summary} · ${note}` : note;
    emit(d);
    persist(d);
    return;
  }
}

function pruneDedup(now: number): void {
  for (const [id, ts] of dedup) {
    if (now - ts > DEDUP_TTL_MS) {
      dedup.delete(id);
    }
  }
}

/**
 * Build a short human-readable summary from a parsed JSON payload. Falls back
 * to the event name when the payload shape is unfamiliar.
 */
export function summarize(event: string, payload: unknown): string {
  if (event === "ping") {
    return "ping";
  }
  if (typeof payload !== "object" || payload === null) {
    return event;
  }
  const p = payload as Record<string, unknown>;
  const repo = readPath(p, ["repository", "full_name"]);
  const action = typeof p.action === "string" ? p.action : null;
  if (event === "pull_request") {
    const num = readPath(p, ["pull_request", "number"]);
    const user = readPath(p, ["pull_request", "user", "login"]);
    return [`PR#${num ?? "?"}`, action, repo, user ? `by ${user}` : null]
      .filter(Boolean)
      .join(" · ");
  }
  if (event === "push") {
    const ref = typeof p.ref === "string" ? p.ref : null;
    const user = readPath(p, ["pusher", "name"]);
    return ["push", ref, repo, user ? `by ${user}` : null].filter(Boolean).join(" · ");
  }
  return [event, action, repo].filter(Boolean).join(" · ") || event;
}

function readPath(obj: Record<string, unknown>, path: string[]): string | null {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) {
      return null;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur === "string" || typeof cur === "number") {
    return String(cur);
  }
  return null;
}
