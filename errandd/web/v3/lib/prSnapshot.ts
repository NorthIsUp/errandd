import type { PrStateInfo } from "../../../shared/prState";
import type { PolledPR } from "./tree";

export interface PrPollSnapshot {
  prs: PolledPR[];
  fetchedAt: number;
  states?: Record<string, PrStateInfo>;
}
export interface PrSidebarSnapshot extends Required<PrPollSnapshot> {
  stateRevision: number;
}

/** A poll started before a live update may refresh PRs, but cannot revert state. */
export function applyPrPoll(
  current: PrSidebarSnapshot,
  poll: PrPollSnapshot,
  startedRevision: number,
): PrSidebarSnapshot {
  return {
    prs: poll.prs,
    fetchedAt: poll.fetchedAt,
    states: current.stateRevision === startedRevision ? (poll.states ?? {}) : current.states,
    stateRevision: current.stateRevision,
  };
}
