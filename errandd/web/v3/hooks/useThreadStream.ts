/**
 * Live transcript subscription for one thread (spec §7).
 *
 * Subscribes to GET /api/v3/threads/:id/stream. An AG-UI STATE_SNAPSHOT
 * initializes the rich transcript and queue status, then STATE_DELTA JSON
 * patches append/update parts and change status as the transcript grows.
 *
 * EventSource can't set an Authorization header, so the token is passed via
 * `?token=` (same pattern as the existing `/api/hooks/events` consumers).
 * Reconnect is handled by the browser's native EventSource backoff; on each
 * (re)connect the server re-emits a `STATE_SNAPSHOT`, which we treat as authoritative.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getApiToken } from "../../api/client";
import type { ChatPart, ThreadStreamEvent } from "../lib/transcriptParts";
import { useForegroundTick } from "./useForegroundTick";

export type ThreadStatus = "idle" | "queued" | "running" | "done" | "error";

export interface ThreadStreamState {
  parts: ChatPart[];
  status: ThreadStatus;
  /** Initial messages fetch in flight (before the first snapshot/page). */
  loading: boolean;
  /** SSE connection is open. */
  connected: boolean;
  error: string | null;
}

/** Replace a part with matching `id`, else append it. */
function upsert(parts: ChatPart[], next: ChatPart): ChatPart[] {
  const idx = parts.findIndex((p) => p.id === next.id);
  if (idx === -1) {
    return [...parts, next];
  }
  const copy = parts.slice();
  copy[idx] = next;
  return copy;
}

function mergeAppend(parts: ChatPart[], incoming: ChatPart[]): ChatPart[] {
  let out = parts;
  for (const p of incoming) {
    out = upsert(out, p);
  }
  return out;
}

export type UseThreadStream = ThreadStreamState & {
  /**
   * Optimistically append a local user echo (used by the composer before the
   * worker run lands). Returns the synthetic part id so callers can reconcile.
   */
  echoUserMessage: (text: string) => string;
  removeEcho: (id: string) => void;
};

export function useThreadStream(threadId: string | null): UseThreadStream {
  const fg = useForegroundTick();
  const [parts, setParts] = useState<ChatPart[]>([]);
  const [status, setStatus] = useState<ThreadStatus>("idle");
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ids the user echoed optimistically; kept across snapshots until the real
  // transcript part with the same text shows up (best-effort reconcile).
  const echoesRef = useRef<Map<string, string>>(new Map());
  const seenUserIdsRef = useRef(new Set<string>());
  const authoritativeStatusRef = useRef<ThreadStatus>("idle");
  const removeEcho = useCallback((id: string) => {
    echoesRef.current.delete(id);
    setParts((prev) => prev.filter((part) => part.id !== id));
    setStatus(authoritativeStatusRef.current);
  }, []);

  const echoUserMessage = useCallback((text: string): string => {
    const id = `echo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    echoesRef.current.set(id, text.trim());
    setParts((prev) => [...prev, { kind: "text", id, role: "user", markdown: text }]);
    setStatus((s) => (s === "running" ? s : "queued"));
    return id;
  }, []);

  // Drop optimistic echoesRef once a real user part with the same text arrives in
  // the authoritative stream, so we don't show the message twice. Reconcile is
  // one-to-one and by occurrence COUNT, not set membership: if the user sent
  // the same text twice, two pending echoesRef must wait for two real messages —
  // a single real arrival only retires one echo, so the second survives.
  const reconcileEchoes = useCallback((authoritative: ChatPart[]) => {
    const available = new Map<string, number>();
    for (const p of authoritative) {
      if (p.kind === "text" && p.role === "user") {
        if (!seenUserIdsRef.current.has(p.id)) {
          const t = p.markdown.trim();
          available.set(t, (available.get(t) ?? 0) + 1);
          seenUserIdsRef.current.add(p.id);
        }
      }
    }
    const retire: string[] = [];
    // Oldest echo first (Map preserves insertion order) so the first-sent
    // duplicate is the first to reconcile.
    for (const [id, text] of echoesRef.current) {
      const remaining = available.get(text) ?? 0;
      if (remaining > 0) {
        available.set(text, remaining - 1);
        retire.push(id);
      }
    }
    if (retire.length === 0) {
      return;
    }
    for (const id of retire) {
      echoesRef.current.delete(id);
    }
    const retireSet = new Set(retire);
    setParts((prev) => prev.filter((p) => !retireSet.has(p.id)));
  }, []);

  // Keep optimistic echoesRef pinned to the tail after a snapshot replaces parts.
  const withEchoes = useCallback((base: ChatPart[]): ChatPart[] => {
    if (echoesRef.current.size === 0) {
      return base;
    }
    const tail: ChatPart[] = [];
    for (const [id, text] of echoesRef.current) {
      tail.push({ kind: "text", id, role: "user", markdown: text });
    }
    return [...base, ...tail];
  }, []);

  // The stream starts with an authoritative snapshot. A parallel HTTP page
  // fetch could land later and replace newer streamed messages.
  useEffect(() => {
    setParts([]);
    setStatus("idle");
    authoritativeStatusRef.current = "idle";
    setLoading(Boolean(threadId));
    setError(null);
    echoesRef.current.clear();
    seenUserIdsRef.current.clear();
  }, [threadId]);

  // SSE subscription.
  useEffect(() => {
    if (!threadId) {
      return;
    }
    const token = getApiToken();
    const url = `/api/v3/threads/${encodeURIComponent(threadId)}/stream${
      token ? `?token=${encodeURIComponent(token)}` : ""
    }`;
    const es = new EventSource(url);

    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false); // native EventSource auto-reconnects
      setLoading(false);
      setError("Connection lost. Reconnecting…");
    };

    es.onmessage = (e) => {
      let ev: ThreadStreamEvent;
      try {
        ev = JSON.parse(e.data as string) as ThreadStreamEvent;
      } catch {
        return; // ignore heartbeats / malformed frames
      }
      switch (ev.type) {
        case "STATE_SNAPSHOT": {
          reconcileEchoes(ev.snapshot.parts);
          setParts(withEchoes(ev.snapshot.parts));
          authoritativeStatusRef.current = ev.snapshot.status;
          setStatus(ev.snapshot.status);
          setLoading(false);
          setError(null);
          break;
        }
        case "STATE_DELTA": {
          for (const patch of ev.delta) {
            if (patch.path === "/status" && typeof patch.value === "string") {
              authoritativeStatusRef.current = patch.value;
              setStatus(patch.value);
            } else if (typeof patch.value === "object") {
              reconcileEchoes([patch.value]);
              setParts((prev) => mergeAppend(prev, [patch.value]));
            }
          }
          break;
        }
      }
    };

    return () => {
      es.close();
      setConnected(false);
    };
  }, [threadId, reconcileEchoes, withEchoes, fg]);

  return {
    parts,
    status,
    loading,
    connected,
    error,
    echoUserMessage,
    removeEcho,
  };
}
