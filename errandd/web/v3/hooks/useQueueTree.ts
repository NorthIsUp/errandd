import { useMemo } from "react";
import type { QueueMessage } from "../../api/hooks";
import { buildTree, type SidebarTree } from "../lib/tree";
import { useSharedQueue } from "./useSharedQueue";

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
 * The sidebar hook tree, built from the durable queue snapshot.
 *
 * Reads the queue off {@link useSharedQueue} — a single EventSource to
 * `/api/hooks/queue/events` shared with the Deliveries view (previously each
 * opened its own socket + retained its own snapshot). The stream pushes a full
 * snapshot on every mutation, so we just rebuild the tree from each one.
 */
export function useQueueTree(): QueueTreeState {
  const { messages, connected } = useSharedQueue();
  const tree = useMemo(() => buildTree(messages), [messages]);
  return {
    tree,
    messages,
    // No separate `error` state: the shared stream retries on its own, and a
    // brief empty-before-connected window reads as loading.
    loading: !connected && messages.length === 0,
    error: null,
    connected,
  };
}
