import { useEffect, useState } from "react";
import { getApiToken } from "../../api/client";
import { listQueue, type QueueMessage } from "../../api/hooks";

/**
 * ONE shared subscription to the live hook queue (`/api/hooks/queue/events`).
 *
 * The sidebar (useQueueTree, always mounted) and the Deliveries view
 * (useDeliveryStream, for jump-to-chat resolution) both need the queue. They
 * used to each open their OWN EventSource + retain their OWN QueueMessage[],
 * doubling the socket count and the retained snapshot whenever Deliveries was
 * open. This module refcounts a single EventSource + a single latest snapshot
 * that every consumer reads.
 */

let es: EventSource | null = null;
let refcount = 0;
let latest: QueueMessage[] = [];
let connected = false;
const msgSubs = new Set<(m: QueueMessage[]) => void>();
const connSubs = new Set<(c: boolean) => void>();

function openStream(): void {
  if (es) {
    return;
  }
  // Seed the first paint with a one-shot fetch before the stream connects.
  listQueue()
    .then((r) => {
      // Don't clobber a snapshot the stream may have already delivered.
      if (latest.length === 0) {
        latest = r.messages;
        for (const f of msgSubs) f(latest);
      }
    })
    .catch(() => {});
  const token = getApiToken();
  const url = `/api/hooks/queue/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  const src = new EventSource(url);
  es = src;
  src.onopen = () => {
    connected = true;
    for (const f of connSubs) f(true);
  };
  src.onerror = () => {
    connected = false;
    for (const f of connSubs) f(false);
  };
  src.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data as string) as { type?: string; messages?: unknown };
      if (ev.type === "snapshot" && Array.isArray(ev.messages)) {
        latest = ev.messages as QueueMessage[];
        for (const f of msgSubs) f(latest);
      }
    } catch {
      // ignore malformed frames
    }
  };
}

function closeStream(): void {
  es?.close();
  es = null;
  connected = false;
}

// A backgrounded EventSource can drop silently (e.g. across a daemon restart);
// re-open on refocus so the snapshot is fresh. Bound once while any consumer
// is mounted.
function onVisibility(): void {
  if (document.visibilityState === "visible" && refcount > 0) {
    closeStream();
    openStream();
  }
}

/** Subscribe to the shared queue snapshot. Returns the latest messages + SSE
 *  liveness; opens the stream on the first consumer, closes it after the last. */
export function useSharedQueue(): { messages: QueueMessage[]; connected: boolean } {
  const [messages, setMessages] = useState<QueueMessage[]>(latest);
  const [isConnected, setIsConnected] = useState(connected);

  useEffect(() => {
    msgSubs.add(setMessages);
    connSubs.add(setIsConnected);
    refcount += 1;
    if (refcount === 1) {
      openStream();
      document.addEventListener("visibilitychange", onVisibility);
    } else {
      // Already streaming — sync this consumer to the current snapshot now.
      setMessages(latest);
      setIsConnected(connected);
    }
    return () => {
      msgSubs.delete(setMessages);
      connSubs.delete(setIsConnected);
      refcount -= 1;
      if (refcount === 0) {
        document.removeEventListener("visibilitychange", onVisibility);
        closeStream();
      }
    };
  }, []);

  return { messages, connected: isConnected };
}
