import type { PrStateSnapshot } from "../../../shared/prState";
import type { PolledPR } from "./tree";

export interface PrPollSnapshot extends Partial<PrStateSnapshot> {
  prs: PolledPR[];
  fetchedAt: number;
}
export interface PrSidebarSnapshot extends PrStateSnapshot {
  prs: PolledPR[];
  fetchedAt: number;
}

/** Both transports obey the same server version, including across daemon restarts. */
export function applyPrStateSnapshot(
  current: PrSidebarSnapshot,
  incoming: PrStateSnapshot,
): PrSidebarSnapshot {
  const previous = current.stateVersion;
  const next = incoming.stateVersion;
  if (
    next.epochMs < previous.epochMs ||
    (next.epochMs === previous.epochMs && next.revision < previous.revision)
  )
    return current;
  return { ...current, ...incoming };
}

/** Legacy polls are unversioned and cannot supersede a versioned live snapshot. */
export function applyPrPoll(current: PrSidebarSnapshot, poll: PrPollSnapshot): PrSidebarSnapshot {
  return {
    ...applyPrStateSnapshot(current, {
      states: poll.states ?? {},
      stateVersion: poll.stateVersion ?? { epochMs: 0, revision: 0 },
    }),
    prs: poll.prs,
    fetchedAt: poll.fetchedAt,
  };
}
