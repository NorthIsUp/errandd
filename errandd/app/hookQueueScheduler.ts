import type { Job } from "./jobs";

export interface HookDrainThread {
  threadId: string;
  jobName: string;
  latestPrUpdateAt?: number;
  reviewLane?: "fresh" | "backlog";
  preflightVersion?: string;
  priority?: "cve" | "small" | "big";
}

const priorityRank = { cve: 0, small: 1, big: 2 };
const smallJobs = new Set(["pr-review", "pr-comments", "pr-babysit", "pr-accepted", "pr-automerge", "dependabot-merge"]);

export function hookJobPriority(job: Pick<Job, "name" | "workload" | "hookConfig"> | undefined): "cve" | "small" | "big" {
  if (job?.hookConfig?.cve || job?.name.startsWith("cve")) return "cve";
  return job?.workload ?? (smallJobs.has(job?.name ?? "") ? "small" : "big");
}

/** Lightweight GitHub checks must not wait behind occupied model workers. */
export function selectReviewPreflightThreads(
  ready: readonly HookDrainThread[],
  busy: ReadonlySet<string>,
  attempts: ReadonlyMap<string, { version: string; at: number }>,
  now: number,
  available: number,
): HookDrainThread[] {
  const limit = Number.isFinite(available) ? Math.max(0, Math.floor(available)) : 0;
  const selected: HookDrainThread[] = [];
  const seen = new Set(busy);
  for (const thread of ready.toSorted((a, b) => (b.latestPrUpdateAt ?? 0) - (a.latestPrUpdateAt ?? 0))) {
    if (selected.length >= limit) break;
    const previous = attempts.get(thread.threadId);
    if (thread.jobName !== "pr-review" || seen.has(thread.threadId) ||
        (previous?.version === (thread.preflightVersion ?? "") && now - previous.at < 5 * 60_000)) continue;
    selected.push(thread);
    seen.add(thread.threadId);
  }
  return selected;
}

/** Keep a lane available for reviews and a lane for other work, within the existing process cap. */
export function selectHookThreads(
  ready: readonly HookDrainThread[],
  active: readonly HookDrainThread[],
  capacity: number,
  reserveReviews = true,
): HookDrainThread[] {
  const limit = Number.isFinite(capacity) ? Math.max(1, Math.floor(capacity)) : 1;
  if (ready.some((thread) => thread.priority)) {
    const occupied = new Set(active.map((thread) => thread.threadId));
    const selected: HookDrainThread[] = [];
    for (const thread of ready.toSorted((a, b) => priorityRank[a.priority ?? "big"] - priorityRank[b.priority ?? "big"])) {
      if (active.length + selected.length >= limit) break;
      if (occupied.has(thread.threadId)) continue;
      selected.push(thread);
      occupied.add(thread.threadId);
    }
    return selected;
  }
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
