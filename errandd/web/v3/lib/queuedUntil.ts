import type { QueueMessage } from "../../api/hooks";

/**
 * Helpers for the "queued-until" UI: when a message is deferred (status
 * `pending` with `notBefore` in the future — e.g. rate-limited until reset) we
 * surface *when* it will resume on the relevant thread/PR row, plus a banner.
 */

/** Is this queue row deferred to a future time (pending + notBefore ahead)? */
export function isDeferred(m: QueueMessage, now: number = Date.now()): boolean {
  return m.status === "pending" && typeof m.notBefore === "number" && m.notBefore > now;
}

/** Earliest `notBefore` among a thread's deferred rows (0 ⇒ none deferred). */
export function deferredUntilForThread(
  messages: QueueMessage[],
  threadId: string,
  now: number = Date.now(),
): number {
  let earliest = 0;
  for (const m of messages) {
    if (m.threadId === threadId && isDeferred(m, now)) {
      earliest = earliest === 0 ? m.notBefore : Math.min(earliest, m.notBefore);
    }
  }
  return earliest;
}

/** Count of currently-deferred messages across the whole queue. */
export function deferredCount(messages: QueueMessage[], now: number = Date.now()): number {
  let n = 0;
  for (const m of messages) {
    if (isDeferred(m, now)) {
      n++;
    }
  }
  return n;
}

/** `HH:MM` in the local timezone (for compact badges). */
export function fmtLocalHM(epochMs: number): string {
  const d = new Date(epochMs);
  if (!Number.isFinite(d.getTime())) {
    return "";
  }
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** `HH:MM UTC` (for the rate-limit banner — reset times are global, so UTC is
 *  unambiguous across viewers). */
export function fmtUtcHM(epochMs: number): string {
  const d = new Date(epochMs);
  if (!Number.isFinite(d.getTime())) {
    return "";
  }
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

/** Ready work and capacity deferrals stay queued; timed continuations are scheduled. */
export function scheduledUntilByThread(messages: QueueMessage[], now = Date.now()): Map<string, number> {
  const scheduled = new Map<string, number>();
  const ready = new Set<string>();
  for (const message of messages) {
    if (message.status === "running" || (message.status === "pending" && (!isDeferred(message, now) || (message.rateLimitAttempts ?? 0) > 0))) ready.add(message.threadId);
    else if (isDeferred(message, now)) scheduled.set(message.threadId, Math.min(scheduled.get(message.threadId) ?? Infinity, message.notBefore));
  }
  for (const thread of ready) scheduled.delete(thread);
  return scheduled;
}
