import { getCachedOpenPRs, getPolledPrStates, markOpenPRsDemand, pollOpenPRs } from "../../pr-poller";
import { getPrStates } from "../../pr-state";
import { isTerminalPrState, type PrStateInfo } from "../../../shared/prState";
import { json } from "../http";
import type { RouteHandler } from "./types";

/**
 * Merge the two state sources into one map for the sidebar.
 *
 * The poller's open list is authoritative about *being open* (it was just
 * fetched), so a PR in it can never read merged/closed however stale the
 * webhook store is. The store still wins within the open states, because it
 * carries mergeability the list doesn't ("conflicted"). PRs absent from the
 * open list are the store's alone — that's where merged/closed comes from.
 */
export function mergePrStates(
  polled: Record<string, ReturnType<typeof getPolledPrStates>[string]>,
  recorded: Record<string, PrStateInfo>,
): Record<string, PrStateInfo> {
  const out: Record<string, PrStateInfo> = {};
  for (const [key, state] of Object.entries(polled)) {
    const known = recorded[key];
    out[key] =
      known && !isTerminalPrState(known.state) ? known : { state, mergeable: known?.mergeable ?? null };
  }
  for (const [key, info] of Object.entries(recorded)) {
    if (!(key in out)) {
      out[key] = info;
    }
  }
  return out;
}

/**
 * GET /api/prs/open — flat list of all open PRs from the reconciliation poller,
 * plus `states`: the per-PR git-state map (`repo#num` → open/draft/merged/
 * closed/conflicted) for every PR the daemon knows about. Requesting this is
 * also what keeps the poller awake; with no dashboard open it idles instead of
 * spending GitHub quota.
 */
export const openPRsList: RouteHandler = () => {
  markOpenPRsDemand();
  const { prs, fetchedAt } = getCachedOpenPRs();
  // Cold cache (fresh daemon, or the poller idled while nobody was watching) —
  // kick one cycle now so the next request has data.
  if (fetchedAt === 0) {
    void pollOpenPRs(true).catch(() => {});
  }
  return json({ prs, fetchedAt, states: mergePrStates(getPolledPrStates(), getPrStates()) });
};
