import { useEffect, useState } from "react";
import { apiJSON } from "../../api/client";
import type { PolledPR } from "../lib/tree";

export type { PolledPR };

interface OpenPRsState {
  prs: PolledPR[];
  fetchedAt: number;
}

interface OpenPRsResponse {
  prs: PolledPR[];
  fetchedAt: number;
}

const EMPTY: OpenPRsState = { prs: [], fetchedAt: 0 };
const POLL_MS = 3 * 60 * 1000;

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
      try {
        const data = await apiJSON<OpenPRsResponse>("/api/prs/open");
        if (!cancelled) {
          setState(data);
        }
      } catch {
        // Transient failure or daemon without the endpoint → leave current state
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
