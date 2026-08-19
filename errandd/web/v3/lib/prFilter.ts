import { businessHoursAgo } from "../../../shared/businessHours";
import type { PrGitState, TreeItem } from "./tree";

/**
 * Per-git-state show/hide filter for the Pull Requests section.
 *
 * Runs before `pageItems` so the section's "X of N" counts describe what the
 * user actually asked to see. Pure + parameterized on `now` for the same reason
 * paging is.
 */

/** Chip order in the filter bar — live states first, then the ended ones. */
export const PR_STATE_ORDER: readonly PrGitState[] = [
  "open",
  "draft",
  "conflicted",
  "merged",
  "closed",
  "unknown",
] as const;

/** States that mean "this PR is over" — the ones the recency window applies to. */
const TERMINAL: ReadonlySet<PrGitState> = new Set<PrGitState>(["merged", "closed"]);

/** The recency window, in business hours, for merged/closed PRs. */
export const TERMINAL_WINDOW_BUSINESS_HOURS = 24;

export interface PrStateFilter {
  visible: Record<PrGitState, boolean>;
  /**
   * Cap merged/closed at the last 24 business hours. On by default: the state
   * store remembers 30 days of ended PRs, and a sidebar showing all of them
   * buries the ones still in flight. Weekend-aware, so Monday still reaches
   * back to Friday (see shared/businessHours.ts).
   */
  recentTerminalOnly: boolean;
}

/** Open + draft + conflicted always, merged/closed only if they just ended. */
export const DEFAULT_PR_FILTER: PrStateFilter = {
  visible: { open: true, draft: true, conflicted: true, merged: true, closed: true, unknown: true },
  recentTerminalOnly: true,
};

/** True when `item` survives the filter. Non-PR rows are never filtered out. */
export function prItemVisible(
  item: TreeItem,
  state: PrGitState | undefined,
  filter: PrStateFilter,
  cutoff: number,
): boolean {
  if (item.num == null) {
    return true;
  }
  const resolved: PrGitState = state ?? "unknown";
  if (!filter.visible[resolved]) {
    return false;
  }
  if (filter.recentTerminalOnly && TERMINAL.has(resolved)) {
    return item.lastAt >= cutoff;
  }
  return true;
}

/** Apply the filter to a section's items. */
export function filterByPrState(
  items: TreeItem[],
  stateByKey: Record<string, PrGitState>,
  filter: PrStateFilter,
  now: number,
): TreeItem[] {
  const cutoff = businessHoursAgo(TERMINAL_WINDOW_BUSINESS_HOURS, now);
  return items.filter((item) => prItemVisible(item, stateByKey[item.key], filter, cutoff));
}
