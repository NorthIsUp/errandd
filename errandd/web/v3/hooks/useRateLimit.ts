import { useEffect, useState } from "react";
import { apiJSON } from "../../api/client";

/**
 * Cross-slice contract: the backend exposes rate-limit state on `/api/state` as
 * `rateLimit: { limited: boolean, resetAt: number }` (`resetAt` is epoch ms; 0
 * when not limited). The v3 frontend reads it to drive the "queued-until"
 * banner. Defined here (not in shared `web/api/state.ts`) so the frontend slice
 * stays self-contained; `resetAt` of 0 / absent ⇒ not limited.
 */
export interface RateLimitState {
  limited: boolean;
  resetAt: number;
}

const EMPTY: RateLimitState = { limited: false, resetAt: 0 };

/** Just the slice of `/api/state` we care about (avoids importing the whole
 *  StateResponse type and coupling to fields this slice doesn't own). */
interface StateRateLimitSlice {
  rateLimit?: { limited?: boolean; resetAt?: number };
}

const POLL_MS = 15_000;

/**
 * Poll `/api/state` for the rate-limit slice. Polling (not SSE) is fine — the
 * banner only needs to flip within ~15s of a rate-limit start/clear, and this
 * keeps the hook dependency-free of any state stream wiring.
 */
export function useRateLimit(): RateLimitState {
  const [state, setState] = useState<RateLimitState>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      try {
        const res = await apiJSON<StateRateLimitSlice>("/api/state");
        if (cancelled) {
          return;
        }
        const rl = res.rateLimit;
        const resetAt = typeof rl?.resetAt === "number" ? rl.resetAt : 0;
        const limited = Boolean(rl?.limited) && resetAt > Date.now();
        setState(limited ? { limited: true, resetAt } : EMPTY);
      } catch {
        // Transient failure (or older daemon without `rateLimit`) → treat as
        // not limited; the next poll recovers.
        if (!cancelled) {
          setState(EMPTY);
        }
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => void load(), POLL_MS);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  return state;
}
