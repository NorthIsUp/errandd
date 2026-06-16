/**
 * Live delivery feed controller for the Deliveries view (spec §9).
 *
 * Owns the two SSE subscriptions and all the stream bookkeeping that used to
 * live inline in DeliveriesView:
 *
 *   - `/api/hooks/events`        → the delivery log (snapshot + per-delivery
 *                                  deltas), with pause/buffer + a "fresh row"
 *                                  fade-in window.
 *   - `/api/hooks/queue/events`  → the live hook queue, kept warm so a delivery
 *                                  can be resolved to the chat thread(s) it
 *                                  spawned (jump-to-chat).
 *
 * The view becomes purely presentational: it reads `deliveries`/`queue`/feed
 * status off this hook and calls `pause()`/`resume()` for the toggle.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getApiToken } from "../../api/client";
import { type Delivery, listQueue, type QueueMessage } from "../../api/hooks";
import { useForegroundTick } from "./useForegroundTick";

// In-BROWSER cap on rendered/retained deliveries. The server ring keeps 10k for
// debugging via the API, but the tab only needs the recent feed: rendering
// thousands of rows unvirtualized was OOM-crashing long-open Safari tabs
// (~30 DOM nodes/row × thousands = hundreds of MB). A few hundred is plenty
// for the live view; older deliveries are still in the DB/API.
const MAX_ROWS = 500;

export type DeliveryStream = {
  /** null until the first snapshot lands; then newest-first, capped. */
  deliveries: Delivery[] | null;
  /** Live hook queue, for resolving a delivery → its chat thread(s). */
  queue: QueueMessage[];
  /** Delivery feed SSE is open. */
  connected: boolean;
  /** Feed paused — incoming deliveries are buffered, not rendered. */
  paused: boolean;
  /** Count of buffered, never-seen deliveries while paused. */
  pendingCount: number;
  /** Ids in the brief fade-in window after first appearing. */
  freshIds: Set<string>;
  pause: () => void;
  resume: () => void;
};

function upsert(list: Delivery[], d: Delivery): Delivery[] {
  const next = [d, ...list.filter((x) => x.id !== d.id)];
  next.sort((a, b) => b.receivedAt - a.receivedAt);
  return next.slice(0, MAX_ROWS);
}

export function useDeliveryStream(): DeliveryStream {
  const fg = useForegroundTick();
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [connected, setConnected] = useState(false);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const [paused, setPaused] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [queue, setQueue] = useState<QueueMessage[]>([]);

  const seen = useRef<Set<string>>(new Set());
  const pausedRef = useRef(false);
  const pending = useRef<Map<string, Delivery>>(new Map());
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const firstSnapshot = useRef(true);

  const markFresh = useCallback((ids: string[]) => {
    if (ids.length === 0) {
      return;
    }
    setFreshIds((s) => {
      const n = new Set(s);
      for (const id of ids) {
        n.add(id);
      }
      return n;
    });
    const t = setTimeout(() => {
      setFreshIds((s) => {
        const n = new Set(s);
        for (const id of ids) {
          n.delete(id);
        }
        return n;
      });
      timers.current.delete(t);
    }, 1000);
    timers.current.add(t);
  }, []);

  const countNewPending = useCallback(() => {
    let n = 0;
    for (const id of pending.current.keys()) {
      if (!seen.current.has(id)) {
        n += 1;
      }
    }
    return n;
  }, []);

  const handleDelta = useCallback(
    (d: Delivery) => {
      if (pausedRef.current) {
        pending.current.set(d.id, d);
        setPendingCount(countNewPending());
        return;
      }
      const isNew = !seen.current.has(d.id);
      setDeliveries((prev) => {
        const next = upsert(prev ?? [], d);
        // Bound `seen` to the retained window — otherwise it accumulates every
        // delivery id for the life of the tab (the only truly unbounded leak).
        seen.current = new Set(next.map((x) => x.id));
        return next;
      });
      if (isNew) {
        markFresh([d.id]);
      }
    },
    [countNewPending, markFresh],
  );

  const resume = useCallback(() => {
    pausedRef.current = false;
    setPaused(false);
    const buffered = [...pending.current.values()].sort((a, b) => a.receivedAt - b.receivedAt);
    pending.current.clear();
    setPendingCount(0);
    if (buffered.length === 0) {
      return;
    }
    const newIds = buffered.filter((d) => !seen.current.has(d.id)).map((d) => d.id);
    setDeliveries((prev) => {
      let next = prev ?? [];
      for (const d of buffered) {
        next = upsert(next, d);
      }
      seen.current = new Set(next.map((x) => x.id));
      return next;
    });
    markFresh(newIds);
  }, [markFresh]);

  const pause = useCallback(() => {
    pausedRef.current = true;
    setPaused(true);
  }, []);

  // Delivery feed (SSE).
  useEffect(() => {
    const token = getApiToken();
    const url = `/api/hooks/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const es = new EventSource(url);
    const localTimers = timers.current;
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data as string) as {
          type?: string;
          deliveries?: unknown;
          delivery?: unknown;
        };
        if (ev.type === "snapshot" && Array.isArray(ev.deliveries)) {
          const list = ev.deliveries as Delivery[];
          if (firstSnapshot.current) {
            firstSnapshot.current = false;
            // Cap the initial snapshot too — the server sends the whole ring
            // (up to 10k), and setting it raw would mount thousands of rows on
            // first paint. Keep only the most-recent MAX_ROWS.
            const capped = list.slice(0, MAX_ROWS);
            seen.current = new Set(capped.map((d) => d.id));
            setDeliveries(capped);
          } else if (pausedRef.current) {
            // Paused: preserve per-item buffering semantics.
            for (const d of list) {
              handleDelta(d);
            }
          } else {
            // Reconnect/refocus snapshot: merge the whole list in ONE pass
            // instead of N sequential full-array upserts (each filter+sort+slice
            // over up to MAX_ROWS). Mark genuinely-new ids fresh.
            const newIds = list.filter((d) => !seen.current.has(d.id)).map((d) => d.id);
            setDeliveries((prev) => {
              const byId = new Map((prev ?? []).map((d) => [d.id, d]));
              for (const d of list) {
                byId.set(d.id, d);
              }
              const next = [...byId.values()]
                .sort((a, b) => b.receivedAt - a.receivedAt)
                .slice(0, MAX_ROWS);
              seen.current = new Set(next.map((d) => d.id));
              return next;
            });
            if (newIds.length > 0) {
              markFresh(newIds);
            }
          }
        } else if (ev.type === "delivery" && ev.delivery) {
          handleDelta(ev.delivery as Delivery);
        }
      } catch {
        // ignore malformed frames
      }
    };
    return () => {
      es.close();
      for (const t of localTimers) {
        clearTimeout(t);
      }
      localTimers.clear();
    };
  }, [handleDelta, markFresh, fg]);

  // Live hook queue (SSE) — fuels threadId resolution for jump-to-chat. We
  // bootstrap with a snapshot fetch and keep it warm via the queue events.
  useEffect(() => {
    let cancelled = false;
    listQueue()
      .then((r) => !cancelled && setQueue(r.messages))
      .catch(() => {});
    const token = getApiToken();
    const url = `/api/hooks/queue/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const es = new EventSource(url);
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data as string) as { type?: string; messages?: unknown };
        if (ev.type === "snapshot" && Array.isArray(ev.messages)) {
          setQueue(ev.messages as QueueMessage[]);
        }
      } catch {
        // ignore
      }
    };
    return () => {
      cancelled = true;
      es.close();
    };
  }, [fg]);

  return { deliveries, queue, connected, paused, pendingCount, freshIds, pause, resume };
}
