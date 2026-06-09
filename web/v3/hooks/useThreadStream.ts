/**
 * Live transcript subscription for one thread (spec §7).
 *
 * Loads the initial page of structured parts from
 *   GET /api/v3/threads/:id/messages
 * then subscribes to
 *   GET /api/v3/threads/:id/stream   (SSE)
 * which emits a `snapshot` of the current parts followed by `append` / `update`
 * deltas as the session jsonl grows, plus `status` deltas (queued/running/done)
 * so the pane can show a running indicator before tokens land.
 *
 * EventSource can't set an Authorization header, so the token is passed via
 * `?token=` (same pattern as the existing `/api/hooks/events` consumers).
 * Reconnect is handled by the browser's native EventSource backoff; on each
 * (re)connect the server re-emits a `snapshot`, which we treat as authoritative.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiJSON, getApiToken } from "../../api/client";
import type { ChatPart, ThreadMessagesResponse, ThreadStreamEvent } from "../lib/transcriptParts";

export type ThreadStatus = "idle" | "queued" | "running" | "done" | "error";

export type ThreadStreamState = {
  parts: ChatPart[];
  status: ThreadStatus;
  /** Initial messages fetch in flight (before the first snapshot/page). */
  loading: boolean;
  /** SSE connection is open. */
  connected: boolean;
  error: string | null;
};

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
};

export function useThreadStream(threadId: string | null): UseThreadStream {
  const [parts, setParts] = useState<ChatPart[]>([]);
  const [status, setStatus] = useState<ThreadStatus>("idle");
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ids the user echoed optimistically; kept across snapshots until the real
  // transcript part with the same text shows up (best-effort reconcile).
  const echoes = useRef<Map<string, string>>(new Map());

  const echoUserMessage = useCallback((text: string): string => {
    const id = `echo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    echoes.current.set(id, text.trim());
    setParts((prev) => [...prev, { kind: "text", id, role: "user", markdown: text }]);
    setStatus((s) => (s === "running" ? s : "queued"));
    return id;
  }, []);

  // Drop optimistic echoes once a real user part with the same text arrives in
  // the authoritative stream, so we don't show the message twice. Reconcile is
  // one-to-one and by occurrence COUNT, not set membership: if the user sent
  // the same text twice, two pending echoes must wait for two real messages —
  // a single real arrival only retires one echo, so the second survives.
  const reconcileEchoes = useCallback((authoritative: ChatPart[]) => {
    if (echoes.current.size === 0) {
      return;
    }
    const available = new Map<string, number>();
    for (const p of authoritative) {
      if (p.kind === "text" && p.role === "user") {
        const t = p.markdown.trim();
        available.set(t, (available.get(t) ?? 0) + 1);
      }
    }
    const retire: string[] = [];
    // Oldest echo first (Map preserves insertion order) so the first-sent
    // duplicate is the first to reconcile.
    for (const [id, text] of echoes.current) {
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
      echoes.current.delete(id);
    }
    const retireSet = new Set(retire);
    setParts((prev) => prev.filter((p) => !retireSet.has(p.id)));
  }, []);

  // Keep optimistic echoes pinned to the tail after a snapshot replaces parts.
  const withEchoes = useCallback((base: ChatPart[]): ChatPart[] => {
    if (echoes.current.size === 0) {
      return base;
    }
    const tail: ChatPart[] = [];
    for (const [id, text] of echoes.current) {
      tail.push({ kind: "text", id, role: "user", markdown: text });
    }
    return [...base, ...tail];
  }, []);

  // Initial page load.
  useEffect(() => {
    if (!threadId) {
      setParts([]);
      setStatus("idle");
      setLoading(false);
      setError(null);
      echoes.current.clear();
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    echoes.current.clear();
    apiJSON<ThreadMessagesResponse>(`/api/v3/threads/${encodeURIComponent(threadId)}/messages`)
      .then((res) => {
        if (cancelled) {
          return;
        }
        setParts(res.parts);
      })
      .catch((e: unknown) => {
        if (cancelled) {
          return;
        }
        // A thread with no transcript yet is not an error — just empty.
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
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
    es.onerror = () => setConnected(false); // native EventSource auto-reconnects

    es.onmessage = (e) => {
      let ev: ThreadStreamEvent;
      try {
        ev = JSON.parse(e.data as string) as ThreadStreamEvent;
      } catch {
        return; // ignore heartbeats / malformed frames
      }
      switch (ev.type) {
        case "snapshot": {
          reconcileEchoes(ev.parts);
          setParts(withEchoes(ev.parts));
          break;
        }
        case "append": {
          reconcileEchoes(ev.parts);
          setParts((prev) => mergeAppend(prev, ev.parts));
          break;
        }
        case "update": {
          reconcileEchoes([ev.part]);
          setParts((prev) => upsert(prev, ev.part));
          break;
        }
        case "status": {
          setStatus(ev.status === "queued" ? "queued" : ev.status);
          break;
        }
      }
    };

    return () => {
      es.close();
      setConnected(false);
    };
  }, [threadId, reconcileEchoes, withEchoes]);

  return {
    parts,
    status,
    loading,
    connected,
    error,
    echoUserMessage,
  };
}
