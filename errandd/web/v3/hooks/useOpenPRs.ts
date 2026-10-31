import { useEffect, useState } from "react";
import { apiJSON, getApiToken } from "../../api/client";
import { prStateSnapshotSchema } from "../../../shared/prState";
import {
  applyPrPoll,
  applyPrStateSnapshot,
  type PrPollSnapshot,
  type PrSidebarSnapshot,
} from "../lib/prSnapshot";
import { useForegroundTick } from "./useForegroundTick";
import type { PolledPR, PrStateInfo } from "../lib/tree";

export type { PolledPR };

/** Per-PR git-state keyed by `repo#num`, accumulated from GitHub webhooks. */
export type PrStateMap = Record<string, PrStateInfo>;

const EMPTY: PrSidebarSnapshot = {
  prs: [],
  fetchedAt: 0,
  states: {},
  stateVersion: { epochMs: 0, revision: 0 },
};
const POLL_MS = 3 * 60 * 1000;
/**
 * The daemon idles its GitHub poller when no dashboard is open, so the first
 * load after a quiet spell gets an empty cache and a kicked-off poll. Come back
 * quickly for that one, rather than leaving the sidebar blank for 3 minutes.
 */
const COLD_RETRY_MS = 10 * 1000;

/**
 * Poll open-list discovery; stream canonical state changes so every PR mirror
 * updates immediately even when no routine subscribes to the webhook.
 */
export function useOpenPRs(): PrSidebarSnapshot {
  const [state, setState] = useState<PrSidebarSnapshot>(EMPTY);
  const foregroundTick = useForegroundTick();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      let cold = false;
      try {
        const data = await apiJSON<PrPollSnapshot>("/api/prs/open");
        cold = data.fetchedAt === 0;
        if (!cancelled) {
          setState((current) => applyPrPoll(current, data));
        }
      } catch {
        // Transient failure or daemon without the endpoint → leave current state
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => void load(), cold ? COLD_RETRY_MS : POLL_MS);
        }
      }
    };

    const token = getApiToken();
    const stream = new EventSource(
      `/api/prs/events${token ? `?token=${encodeURIComponent(token)}` : ""}`,
    );
    stream.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== "string") return;
      try {
        const snapshot = prStateSnapshotSchema.safeParse(JSON.parse(event.data));
        if (cancelled || !snapshot.success) return;
        setState((current) => applyPrStateSnapshot(current, snapshot.data));
      } catch {
        // Malformed frames leave the last valid snapshot intact.
      }
    };
    void load();
    return () => {
      cancelled = true;
      stream.close();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [foregroundTick]);

  return state;
}
