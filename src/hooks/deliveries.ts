/**
 * In-memory ring buffer of recently received GitHub webhook deliveries.
 *
 * Lost on daemon restart by design — this is a "what's hitting me right now?"
 * debugging surface, not a durable audit log. A future iteration can persist
 * to disk if the user needs that.
 */

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
}

const MAX_DELIVERIES = 50;
/** Long enough to catch GitHub's typical retry window; not so long that it
 *  bloats memory. */
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

const ring: Delivery[] = [];
const dedup = new Map<string, number>(); // id → receivedAt

/** Append a delivery to the ring. Returns true if this is the first time
 *  we've seen this delivery id within the dedup window. */
export function recordDelivery(d: Delivery): boolean {
  const now = Date.now();
  pruneDedup(now);

  const seen = dedup.has(d.id);
  dedup.set(d.id, now);

  ring.unshift(d);
  while (ring.length > MAX_DELIVERIES) {
    ring.pop();
  }
  return !seen;
}

export function recentDeliveries(): Delivery[] {
  return ring.slice();
}

/**
 * Append a "static skip" note to an existing delivery's summary. Called
 * from the matcher path when the daemon decides not to spawn Claude for
 * a delivery (bot user, PR targets main, etc.). Best-effort — if the
 * delivery has aged out of the ring, the call is a no-op.
 */
export function annotateSkip(deliveryId: string, jobName: string, reason: string): void {
  for (const d of ring) {
    if (d.id !== deliveryId) continue;
    const note = `skip ${jobName}: ${reason}`;
    // Don't double-append the exact same note if multiple jobs share a
    // skip reason — the ring is small enough that a substring check is
    // fine and keeps the summary readable.
    if (d.summary.includes(note)) return;
    d.summary = d.summary ? `${d.summary} · ${note}` : note;
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
