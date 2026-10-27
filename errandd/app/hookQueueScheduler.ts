export interface HookDrainThread {
  threadId: string;
  jobName: string;
  latestPrUpdateAt?: number;
  reviewLane?: "fresh" | "backlog";
}

/** Keep a lane available for reviews and a lane for other work, within the existing process cap. */
export function selectHookThreads(
  ready: readonly HookDrainThread[],
  active: readonly HookDrainThread[],
  capacity: number,
  reserveReviews = true,
): HookDrainThread[] {
  const limit = Number.isFinite(capacity) ? Math.max(1, Math.floor(capacity)) : 1;
  const laneLimit = reserveReviews && limit > 1 ? limit - 1 : limit;
  const occupied = new Set(active.map((thread) => thread.threadId));
  let reviews = active.filter((thread) => thread.jobName === "pr-review").length;
  let background = active.length - reviews;
  const selected: HookDrainThread[] = [];
  // The default three-worker pool has one live-PR lane, one backlog lane and one other-work lane.
  if (reserveReviews && limit >= 3 && reviews < laneLimit && active.length < limit &&
      !active.some((thread) => thread.reviewLane === "fresh")) {
    const candidates = ready.filter((thread) => thread.jobName === "pr-review" && !occupied.has(thread.threadId));
    const fresh = candidates.reduce<HookDrainThread | undefined>((best, thread) =>
      !best || (thread.latestPrUpdateAt ?? 0) > (best.latestPrUpdateAt ?? 0) ? thread : best, undefined);
    if (fresh) {
      selected.push({ ...fresh, reviewLane: "fresh" });
      occupied.add(fresh.threadId);
      reviews += 1;
    }
  }
  for (const thread of ready) {
    if (active.length + selected.length >= limit) break;
    if (occupied.has(thread.threadId)) continue;
    const review = thread.jobName === "pr-review";
    if ((review ? reviews : background) >= laneLimit) continue;
    selected.push(review && reserveReviews && limit >= 3 ? { ...thread, reviewLane: "backlog" } : thread);
    occupied.add(thread.threadId);
    if (review) reviews += 1;
    else background += 1;
  }
  return selected;
}
