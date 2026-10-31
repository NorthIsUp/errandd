import {
  getCachedBranches,
  getCachedOpenPRs,
  getPolledPrStates,
  markOpenPRsDemand,
  pollOpenPRs,
} from "../../pr-poller";
import { getPrStates, subscribePrStates } from "../../pr-state";
import { isTerminalPrState, type PrStateInfo } from "../../../shared/prState";
import { json } from "../http";
import type { RouteHandler } from "./types";

/**
 * Merge the two state sources into one map for the sidebar.
 *
 * Merged is irreversible and outranks an older open-list cache. A closed PR
 * can reopen, so the poll still overrides that state. The store owns conflict
 * details that the list does not carry.
 */
export function mergePrStates(
  polled: Record<string, ReturnType<typeof getPolledPrStates>[string]>,
  recorded: Record<string, PrStateInfo>,
): Record<string, PrStateInfo> {
  const out: Record<string, PrStateInfo> = {};
  for (const [key, state] of Object.entries(polled)) {
    const known = recorded[key];
    out[key] =
      known && (known.state === "merged" || !isTerminalPrState(known.state))
        ? known
        : { state, mergeable: known?.mergeable ?? null };
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
  return json({
    prs,
    fetchedAt,
    branches: getCachedBranches(),
    states: mergePrStates(getPolledPrStates(), getPrStates()),
  });
};

/** Publish the canonical state snapshot independently of routine fan-out. */
export const prStateEvents: RouteHandler = ({ req, sseResponse }) =>
  sseResponse(req, (send) => {
    markOpenPRsDemand();
    const snapshot = () => send({ states: mergePrStates(getPolledPrStates(), getPrStates()) });
    return subscribePrStates(snapshot);
  });
