import { useEffect, useMemo, useRef, useState } from "react";
import { getApiToken } from "../../api/client";
import { listQueue, type QueueMessage } from "../../api/hooks";
import { buildTree, type SidebarTree } from "../lib/tree";

export interface QueueTreeState {
  tree: SidebarTree;
  /** Raw queue rows (kept so callers can derive extra detail if needed). */
  messages: QueueMessage[];
  loading: boolean;
  error: Error | null;
  /** SSE liveness — drives the sidebar's live/offline dot. */
  connected: boolean;
}

/**
 * Subscribe to the durable hook queue and maintain the live sidebar tree.
 *
 * The queue SSE (`/api/hooks/queue/events`) pushes a *full* `snapshot` of the
 * message list on every mutation (debounced 200ms server-side), so we simply
 * rebuild the tree from each snapshot — no client-side delta merging needed.
 * A one-shot `GET /api/hooks/queue` seeds the first paint before the stream
 * connects.
 */
export function useQueueTree(): QueueTreeState {
  const [messages, setMessages] = useState<QueueMessage[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [connected, setConnected] = useState(false);
  // Whether the SSE has delivered at least one snapshot — once it has, it owns
  // the message list and the initial fetch result is ignored if it lands late.
  const streamSeeded = useRef(false);

  // Seed paint with a snapshot fetch (cheap, runs once).
  useEffect(() => {
    let cancelled = false;
    listQueue()
      .then((res) => {
        if (cancelled || streamSeeded.current) {
          return;
        }
        setMessages(res.messages);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e : new Error(String(e)));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live stream — authoritative once connected.
  useEffect(() => {
    const token = getApiToken();
    const url = `/api/hooks/queue/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    const es = new EventSource(url);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data as string) as { type?: string; messages?: unknown };
        if (ev.type === "snapshot" && Array.isArray(ev.messages)) {
          streamSeeded.current = true;
          setMessages(ev.messages as QueueMessage[]);
          setError(null);
        }
      } catch {
        // ignore malformed frames
      }
    };
    return () => es.close();
  }, []);

  const tree = useMemo(() => buildTree(messages ?? []), [messages]);

  return {
    tree,
    messages: messages ?? [],
    loading: messages === null && error === null,
    error,
    connected,
  };
}
