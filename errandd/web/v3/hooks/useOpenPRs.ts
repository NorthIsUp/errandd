import { useEffect, useState } from "react";
import { apiJSON } from "../../api/client";
import type { PolledPR, PrStateInfo } from "../lib/tree";

export type { PolledPR };

/** Per-PR git-state keyed by `repo#num`, accumulated from GitHub webhooks. */
export type PrStateMap = Record<string, PrStateInfo>;

interface OpenPRsState {
  prs: PolledPR[];
  fetchedAt: number;
  states: PrStateMap;
}

interface OpenPRsResponse {
  prs: PolledPR[];
  fetchedAt: number;
  /** Absent on older daemons — normalized to `{}` below. */
  states?: PrStateMap;
}

const EMPTY: OpenPRsState = { prs: [], fetchedAt: 0, states: {} };
const POLL_MS = 3 * 60 * 1000;
/**
 * The daemon idles its GitHub poller when no dashboard is open, so the first
 * load after a quiet spell gets an empty cache and a kicked-off poll. Come back
 * quickly for that one, rather than leaving the sidebar blank for 3 minutes.
 */
const COLD_RETRY_MS = 10 * 1000;

/**
 * Poll `/api/prs/open` for the reconciliation-poller cache. Polling (not SSE)
 * is fine — the sidebar only needs to update within 3 minutes of a repo change,
 * and this keeps the hook free of any event-stream wiring.
 */
export function useOpenPRs(): OpenPRsState {
  const [state, setState] = useState<OpenPRsState>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      let cold = false;
      try {
        const data = await apiJSON<OpenPRsResponse>("/api/prs/open");
        cold = data.fetchedAt === 0;
        if (!cancelled) {
          setState({ prs: data.prs, fetchedAt: data.fetchedAt, states: data.states ?? {} });
        }
      } catch {
        // Transient failure or daemon without the endpoint → leave current state
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => void load(), cold ? COLD_RETRY_MS : POLL_MS);
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
