/**
 * In-memory ring buffer of recently received GitHub webhook deliveries.
 *
 * Lost on daemon restart by design — this is a "what's hitting me right now?"
 * debugging surface, not a durable audit log. A future iteration can persist
 * to disk if the user needs that.
 */

/** Which provider sent the delivery. Derived from the event name prefix. */
export type DeliverySource = "github" | "sentry" | "datadog";

/** One "most important" extracted field, surfaced to the routine prompt and
 *  shown in the deliveries table (e.g. {label:"repo", value:"org/x"}). */
export interface DeliveryField {
  label: string;
  value: string;
}

/** Per-routine outcome for a delivery: did it fire (trigger) or get filtered
 *  out (skip, with a human reason). Routines with no trigger for this
 *  provider/event aren't listed. */
export interface DeliveryRoutine {
  job: string;
  outcome: "trigger" | "skip";
  /** Why it skipped (config filter, self-skip, …). Unset for triggers. */
  reason?: string;
}

export interface Delivery {
  /** GitHub's X-GitHub-Delivery UUID. Used both as the dedup key and the
   *  buffer entry id. */
  id: string;
  /** Header X-GitHub-Event (e.g. "pull_request", "push", "ping"). */
  event: string;
  /** Server clock at receipt. */
  receivedAt: number;
  /** Brief summary derived from the payload (action + repo + actor) so the
   *  UI can render a useful one-liner without inspecting the body. */
  summary: string;
  /** Outcome we attempted: verified + accepted, signature-rejected, etc. */
  status: "ok" | "duplicate" | "bad-signature" | "missing-secret" | "error";
  /** When matcher runs in pass 2: names of jobs that matched this delivery. */
  matched: string[];
  /** Truncated raw payload (first ~2KB) for inspection in the UI. */
  payloadSnippet: string;
  /** Provider that sent this. Normalized from `event` on record. */
  source?: DeliverySource;
  /** Short "primary key" headline for this delivery — GitHub PR#/branch,
   *  Sentry issue id, Datadog monitor id. Set by the matcher after dispatch. */
  pk?: string;
  /** "Most important" fields extracted for this hook type (provider-specific:
   *  PR repo/#/author/…, Sentry project/level/…, Datadog monitor/priority/…).
   *  Set by the matcher after dispatch. */
  fields?: DeliveryField[];
  /** Per-routine trigger/skip outcomes. Set by the matcher after dispatch. */
  routines?: DeliveryRoutine[];
  /** Full parsed payload, kept in memory only (not in the list response) so
   *  the UI can fetch + prettify it on demand. */
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
  if (evaluation.fields) {
    d.fields = evaluation.fields;
  }
  if (evaluation.routines) {
    d.routines = evaluation.routines;
  }
  emit(d);
}

/** Stash the full parsed payload on the in-ring delivery so the UI can fetch
 *  and prettify it on demand. Kept in memory only. Best-effort. */
export function attachDeliveryPayload(id: string, payload: unknown): void {
  const d = ring.find((x) => x.id === id);
  if (d) {
    d.payload = payload;
  }
}

/** The full parsed payload for a delivery id, or null if unknown / aged out. */
export function getDeliveryPayload(id: string): { event: string; payload: unknown } | null {
  const d = ring.find((x) => x.id === id);
  if (!d || d.payload === undefined) {
    return null;
  }
  return { event: d.event, payload: d.payload };
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
    return;
  }
}

export function lastDelivery(): Delivery | null {
  return ring[0] ?? null;
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
