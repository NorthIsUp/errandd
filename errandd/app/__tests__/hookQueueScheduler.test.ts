import { describe, expect, test } from "bun:test";
import { selectHookThreads, selectReviewPreflightThreads, type HookDrainThread } from "../hookQueueScheduler";

const review = (id: string): HookDrainThread => ({ threadId: id, jobName: "pr-review" });
const background = (id: string): HookDrainThread => ({ threadId: id, jobName: "cve" });

describe("hook drain scheduling", () => {
  test("background backlog cannot occupy the review slot", () => {
    expect(selectHookThreads([background("a"), background("b"), background("c")], [], 3))
      .toMatchObject([background("a"), background("b")]);
    expect(selectHookThreads([background("c"), review("new")], [background("a"), background("b")], 3))
      .toMatchObject([review("new")]);
  });

  test("review backlog cannot starve other routines", () => {
    expect(selectHookThreads([review("a"), review("b"), review("c"), background("work")], [], 3))
      .toMatchObject([review("a"), review("b"), background("work")]);
  });

  test("spare capacity is usable when no review routine is loaded", () => {
    const ready = [background("a"), background("b"), background("c")];
    expect(selectHookThreads(ready, [], 3, false)).toEqual(ready);
  });

  test("single-worker deployment uses FIFO rather than reserving its only slot", () => {
    expect(selectHookThreads([background("old"), review("new")], [], 1)).toEqual([background("old")]);
    expect(selectHookThreads([review("old"), background("new")], [], 1)).toEqual([review("old")]);
  });

  test("active and duplicate threads cannot be claimed twice", () => {
    expect(selectHookThreads([review("active"), review("new"), review("new"), background("other")], [review("active")], 3))
      .toMatchObject([review("new"), background("other")]);
  });

  test("lowered capacity never starts extra work while older workers finish", () => {
    expect(selectHookThreads([review("new")], [background("a"), background("b"), background("c")], 2)).toEqual([]);
    expect(selectHookThreads([review("new")], [background("a")], 2)).toMatchObject([review("new")]);
  });

  test("selection obeys process and lane limits across mixed occupancy", () => {
    const ready = [review("r1"), background("b1"), review("r2"), background("b2"), review("r3")];
    for (let capacity = 1; capacity <= 5; capacity++) {
      for (let reviews = 0; reviews <= capacity; reviews++) {
        for (let others = 0; others <= capacity - reviews; others++) {
          const active = [
            ...Array.from({ length: reviews }, (_, i) => review(`active-r${i}`)),
            ...Array.from({ length: others }, (_, i) => background(`active-b${i}`)),
          ];
          const selected = selectHookThreads(ready, active, capacity);
          expect(selected.length + active.length).toBeLessThanOrEqual(capacity);
          const newReviews = selected.filter((t) => t.jobName === "pr-review").length;
          const laneLimit = capacity > 1 ? capacity - 1 : 1;
          if (newReviews) expect(newReviews + reviews).toBeLessThanOrEqual(laneLimit);
          if (selected.length - newReviews) expect(selected.length - newReviews + others).toBeLessThanOrEqual(laneLimit);
        }
      }
    }
  });
});


test("new PR updates get a live lane while the oldest backlog continues", () => {
  const oldest = { ...review("oldest"), latestPrUpdateAt: 1 };
  const newest = { ...review("newest"), latestPrUpdateAt: 100 };
  const ciWake = review("ci-wake");
  const selected = selectHookThreads([oldest, ciWake, newest, background("other")], [], 3);
  expect(selected).toMatchObject([
    { threadId: "newest", reviewLane: "fresh" },
    { threadId: "oldest", reviewLane: "backlog" },
    { threadId: "other" },
  ]);
  expect(selectHookThreads([ciWake, review("later")], [selected[0], selected[2]], 3))
    .toMatchObject([{ threadId: "ci-wake", reviewLane: "backlog" }]);
  expect(selectHookThreads([newest, ciWake], [selected[1], selected[2]], 3))
    .toMatchObject([{ threadId: "newest", reviewLane: "fresh" }]);
});


test.each([Number.POSITIVE_INFINITY, Number.NaN, -1, 0])("invalid capacity %s cannot launch an unbounded drain", (capacity) => {
  expect(selectHookThreads([background("a"), review("b")], [], capacity)).toHaveLength(1);
});


describe("model-free review lane", () => {
  test("a full model pool cannot block a newly labeled approved PR", () => {
    const active = [review("long-review"), background("cve"), background("comments")];
    const ready = [{ ...review("label-added"), latestPrUpdateAt: 100 }, background("other")];
    expect(selectHookThreads(ready, active, 3)).toEqual([]);
    expect(selectReviewPreflightThreads(ready, new Set(active.map((t) => t.threadId)), new Map(), 100, 2))
      .toEqual([ready[0]]);
  });
  test("bounds lightweight concurrency and never inspects an already active thread", () => {
    const ready = [review("active"), review("a"), review("a"), review("b"), review("c"), background("other")];
    expect(selectReviewPreflightThreads(ready, new Set(["active"]), new Map(), 100, 2))
      .toEqual([review("a"), review("b")]);
    expect(selectReviewPreflightThreads(ready, new Set(), new Map(), 100, 0)).toEqual([]);
  });
  test("unknown eligibility returns to the model pool without a busy polling loop", () => {
    const attempted = new Map([["needs-model", { version: "", at: 1_000 }]]);
    const ready = [review("needs-model"), { ...review("new-label"), latestPrUpdateAt: 10 }];
    expect(selectReviewPreflightThreads(ready, new Set(), attempted, 2_000, 2)).toEqual([ready[1]]);
    expect(selectHookThreads([ready[0]], [], 3)).toHaveLength(1);
    expect(selectReviewPreflightThreads([ready[0]], new Set(), attempted, 301_000, 2)).toEqual([ready[0]]);
  });
  test("fresh PR events outrank a preflight backlog", () => {
    const ready = [{ ...review("old"), latestPrUpdateAt: 1 }, { ...review("fresh"), latestPrUpdateAt: 9 }];
    expect(selectReviewPreflightThreads(ready, new Set(), new Map(), 100, 1)).toEqual([ready[1]]);
  });
});


test("a new delivery bypasses an unchanged batch's preflight cooldown immediately", () => {
  const old = { ...review("same-pr"), preflightVersion: "old" };
  const labelAdded = { ...old, preflightVersion: "label-added" };
  const attempts = new Map([["same-pr", { version: "old", at: 1_000 }]]);
  expect(selectReviewPreflightThreads([old], new Set(), attempts, 1_001, 2)).toEqual([]);
  expect(selectReviewPreflightThreads([labelAdded], new Set(), attempts, 1_001, 2)).toEqual([labelAdded]);
});
