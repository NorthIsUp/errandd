import {
  getCachedBranches,
  getCachedOpenPRs,
  markOpenPRsDemand,
  pollOpenPRs,
} from "../../pr-poller";
import { getPrStateSnapshot, subscribePrStates } from "../../pr-state";
import { json } from "../http";
import type { RouteHandler } from "./types";

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
    ...getPrStateSnapshot(),
  });
};

/** Publish the canonical state snapshot independently of routine fan-out. */
export const prStateEvents: RouteHandler = ({ req, sseResponse }) =>
  sseResponse(req, (send) => {
    markOpenPRsDemand();
    const snapshot = () => send(getPrStateSnapshot());
    return subscribePrStates(snapshot);
  });
