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
import { apiJSON, getApiToken } from "../../api/client";
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

/** Merge by stable transcript id once per frame, including an older page. */
function mergeAppend(parts: ChatPart[], incoming: ChatPart[]): ChatPart[] {
  const byId = new Map(parts.map(part => [part.id, part]));
  for (const part of incoming) byId.set(part.id, part);
  const order = (id: string) => {
    if (id.startsWith("echo-")) return Number.POSITIVE_INFINITY;
    const [line, block] = id.split(":");
    return Number(line) * 1_000_000 + (Number(block) || 0);
  };
  return [...byId.values()].sort((a, b) => order(a.id) - order(b.id));
}

const threadCache = new Map<string, { parts: ChatPart[]; status: ThreadStatus; olderCount: number }>();
function remember(threadId: string, parts: ChatPart[], status: ThreadStatus, olderCount: number) {
  threadCache.delete(threadId);
  const real = parts.filter(part => !part.id.startsWith("echo-"));
  const trimmed = Math.max(0, real.length - 2000);
  threadCache.set(threadId, { parts: real.slice(trimmed), status, olderCount: olderCount + trimmed });
  if (threadCache.size > 8) threadCache.delete(threadCache.keys().next().value!);
}

export type UseThreadStream = ThreadStreamState & {
  olderCount: number;
  loadingOlder: boolean;
  loadOlder: () => void;
  /**
   * Optimistically append a local user echo (used by the composer before the
   * worker run lands). Returns the synthetic part id so callers can reconcile.
   */
  echoUserMessage: (text: string) => string;
  removeEcho: (id: string) => void;
};

export function useThreadStream(threadId: string | null): UseThreadStream {
  const fg = useForegroundTick();
  const [olderCount, setOlderCount] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const historyGenerationRef = useRef(0);
  const olderCountRef = useRef(0);
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
    const cached = threadId ? threadCache.get(threadId) : undefined;
    setParts(cached?.parts ?? []);
    setStatus(cached?.status ?? "idle");
    authoritativeStatusRef.current = cached?.status ?? "idle";
    setLoading(Boolean(threadId) && !cached);
    olderCountRef.current = cached?.olderCount ?? 0;
    setOlderCount(olderCountRef.current);
    historyGenerationRef.current++;
    setLoadingOlder(false);
    setError(null);
    echoesRef.current.clear();
    seenUserIdsRef.current.clear();
  }, [threadId]);

  const loadOlder = useCallback(() => {
    if (!threadId || loadingOlder || olderCountRef.current <= 0) return;
    const generation = historyGenerationRef.current;
    const offset = Math.max(0, olderCountRef.current - 200);
    const limit = olderCountRef.current - offset;
    setLoadingOlder(true);
    void apiJSON<{ parts: ChatPart[] }>(`/api/v3/threads/${encodeURIComponent(threadId)}/messages?limit=${limit}&offset=${offset}`)
      .then(page => {
        if (historyGenerationRef.current !== generation) return;
        olderCountRef.current = offset;
        setOlderCount(offset);
        setParts(previous => {
          const merged = mergeAppend(previous, page.parts);
          remember(threadId, merged, authoritativeStatusRef.current, offset);
          return merged;
        });
      }).catch(error => {
        if (historyGenerationRef.current === generation) setError(String(error));
      }).finally(() => {
        if (historyGenerationRef.current === generation) setLoadingOlder(false);
      });
  }, [threadId, loadingOlder]);

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
    let closed = false;

    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false); // native EventSource auto-reconnects
      setLoading(false);
      setError("Connection lost. Reconnecting…");
    };

    es.onmessage = (e) => {
      if (closed) return;
      let ev: ThreadStreamEvent;
      try {
        ev = JSON.parse(e.data as string) as ThreadStreamEvent;
      } catch {
        return; // ignore heartbeats / malformed frames
      }
      switch (ev.type) {
        case "STATE_SNAPSHOT": {
          historyGenerationRef.current++;
          setLoadingOlder(false);
          olderCountRef.current = ev.snapshot.olderCount ?? 0;
          setOlderCount(olderCountRef.current);
          reconcileEchoes(ev.snapshot.parts);
          remember(threadId, ev.snapshot.parts, ev.snapshot.status, olderCountRef.current);
          setParts(withEchoes(ev.snapshot.parts));
          authoritativeStatusRef.current = ev.snapshot.status;
          setStatus(ev.snapshot.status);
          setLoading(false);
          setError(null);
          break;
        }
        case "STATE_DELTA": {
          const incoming: ChatPart[] = [];
          for (const patch of ev.delta) {
            if (patch.path === "/status" && typeof patch.value === "string") {
              authoritativeStatusRef.current = patch.value;
              setStatus(patch.value);
              const cached = threadCache.get(threadId);
              if (cached) cached.status = patch.value;
            } else if (typeof patch.value === "object") {
              incoming.push(patch.value);
            }
          }
          if (incoming.length) {
            reconcileEchoes(incoming);
            setParts(previous => {
              const merged = mergeAppend(previous, incoming);
              remember(threadId, merged, authoritativeStatusRef.current, olderCountRef.current);
              return merged;
            });
          }
          break;
        }
      }
    };

    return () => {
      closed = true;
      es.close();
      setConnected(false);
    };
  }, [threadId, reconcileEchoes, withEchoes, fg]);

  return {
    olderCount, loadingOlder, loadOlder,
    parts,
    status,
    loading,
    connected,
    error,
    echoUserMessage,
    removeEcho,
  };
}
