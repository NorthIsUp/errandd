import { useEffect, useState } from "react";
import { getApiToken } from "../../api/client";

/**
 * threadId → total tokens (input + output + cache read + cache write) summed
 * across that thread's session(s). Powers the per-PR token figure in the
 * sidebar. Sourced from /api/usage, whose per-session `label` is `#<threadId>`
 * for hook sessions — strip the `#` to map back to the tree's threadId.
 *
 * Polled on a slow interval (usage moves only as runs complete); the endpoint
 * itself caches for 60s, so this never hammers the JSONL parse.
 */
export type UsageByThread = Map<string, number>;

type UsageRow = {
  label?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export function useUsage(): UsageByThread {
  const [byThread, setByThread] = useState<UsageByThread>(() => new Map());

  useEffect(() => {
    let alive = true;
    const token = getApiToken();
    const url = `/api/usage${token ? `?token=${encodeURIComponent(token)}` : ""}`;

    const load = async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) {
          return;
        }
        const rows = (await res.json()) as UsageRow[];
        const next: UsageByThread = new Map();
        for (const r of rows) {
          const threadId = (r.label ?? "").replace(/^#/, "").trim();
          if (!threadId) {
            continue;
          }
          const total =
            (r.inputTokens ?? 0) +
            (r.outputTokens ?? 0) +
            (r.cacheReadTokens ?? 0) +
            (r.cacheWriteTokens ?? 0);
          next.set(threadId, (next.get(threadId) ?? 0) + total);
        }
        if (alive) {
          setByThread(next);
        }
      } catch {
        // best-effort — sidebar still works without token figures
      }
    };

    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return byThread;
}
