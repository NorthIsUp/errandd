import { describe, expect, test } from "bun:test";
import { HookQueue, nextQueueAction } from "../hookQueue";

describe("nextQueueAction (retry/defer policy)", () => {
  const d = { rateLimitResetAt: 50_000, priorAttempts: 0, cap: 5, now: 1000 };
  test("exit 0 → done", () => {
    expect(nextQueueAction({ ...d, exitCode: 0, rateLimited: false }).action).toBe("done");
  });
  test("rate-limited → defer to reset, no retry burned", () => {
    const a = nextQueueAction({ ...d, exitCode: 1, rateLimited: true, priorAttempts: 2 });
    expect(a).toEqual({ action: "defer", notBefore: 50_000, error: "rate limited" });
  });
  test("failure → exponential backoff defer under the cap", () => {
    const a1 = nextQueueAction({ ...d, exitCode: 1, rateLimited: false, priorAttempts: 0 });
    expect(a1.action).toBe("defer");
    expect(a1.notBefore).toBe(1000 + 60_000); // attempt 1 → 60s
    const a2 = nextQueueAction({ ...d, exitCode: 1, rateLimited: false, priorAttempts: 1 });
    expect(a2.notBefore).toBe(1000 + 120_000); // attempt 2 → 120s
  });
  test("attempt 5 → 16m (1/2/4/8/16 schedule under cap 5)", () => {
    const a = nextQueueAction({ ...d, exitCode: 1, rateLimited: false, priorAttempts: 4 });
    expect(a.notBefore).toBe(1000 + 16 * 60_000);
  });
  test("backoff caps at 30m for high attempts", () => {
    const a = nextQueueAction({ ...d, exitCode: 1, rateLimited: false, priorAttempts: 8, cap: 12 });
    expect(a.notBefore).toBe(1000 + 30 * 60_000); // attempt 9 → 2^8*60s capped
  });
  test("past the cap → fail (terminal)", () => {
    const a = nextQueueAction({ ...d, exitCode: 1, rateLimited: false, priorAttempts: 5 });
    expect(a.action).toBe("fail");
  });

  // P0-14: a coalesced batch mixes attempt counts. The cap is checked on the
  // FRESHEST message (min) so brand-new work isn't failed by an old message's
  // burned attempts, while backoff timing uses the MOST-tried (max).
  test("coalesced batch: fresh work survives an old message at the cap", () => {
    // max=5 (would fail), min=0 (fresh) → batch defers, not fails.
    const a = nextQueueAction({
      ...d,
      exitCode: 1,
      rateLimited: false,
      priorAttempts: 5, // backoff driver
      capAttempts: 0, // cap driver (freshest)
    });
    expect(a.action).toBe("defer");
    // backoff uses max → attempt 6 → 2^5*60s = 32m capped to 30m.
    expect(a.notBefore).toBe(1000 + 30 * 60_000);
  });

  test("coalesced batch: fails only once the freshest message hits the cap", () => {
    const a = nextQueueAction({
      ...d,
      exitCode: 1,
      rateLimited: false,
      priorAttempts: 9,
      capAttempts: 5, // freshest has now also exhausted its retries
    });
    expect(a.action).toBe("fail");
  });

  test("capAttempts defaults to priorAttempts (single-message callers)", () => {
    const a = nextQueueAction({ ...d, exitCode: 1, rateLimited: false, priorAttempts: 5 });
    expect(a.action).toBe("fail");
  });
});

function q(): HookQueue {
  return new HookQueue(":memory:");
}

const base = {
  threadId: "pr-comments:hook:pr-1542-fix",
  jobName: "pr-comments",
  event: "issue_comment",
  scope: "pr-1542-fix",
  payload: { hello: 1 },
  prRepo: "org/app",
  prNumber: 1542,
};

describe("enqueue + dedup", () => {
  test("new delivery enqueues; same id is ignored (durable dedup)", () => {
    const queue = q();
    expect(queue.enqueue({ ...base, id: "d1" })).toBe(true);
    expect(queue.enqueue({ ...base, id: "d1" })).toBe(false); // GitHub retry
    expect(queue.list().length).toBe(1);
  });

  test("stores PR repo/number + parses payload back", () => {
    const queue = q();
    queue.enqueue({ ...base, id: "d1", payload: { a: [1, 2] } });
    const m = queue.list()[0];
    expect(m).toMatchObject({ prRepo: "org/app", prNumber: 1542, status: "pending" });
    expect(m.payload).toEqual({ a: [1, 2] });
  });
});

describe("claimThread coalesces", () => {
  test("claims all ready-pending for a thread, marks running, oldest-first", () => {
    const queue = q();
    queue.enqueue({ ...base, id: "d1", enqueuedAt: 100 });
    queue.enqueue({ ...base, id: "d2", enqueuedAt: 200 });
    queue.enqueue({ ...base, id: "d3", enqueuedAt: 300 });
    const claimed = queue.claimThread(base.threadId, 1000);
    expect(claimed.map((m) => m.id)).toEqual(["d1", "d2", "d3"]);
    // all now running → a second claim returns nothing
    expect(queue.claimThread(base.threadId, 1000)).toEqual([]);
    expect(queue.list({ status: "running" }).length).toBe(3);
  });

  test("does not claim a different thread's messages", () => {
    const queue = q();
    queue.enqueue({ ...base, id: "a1" });
    queue.enqueue({ ...base, id: "b1", threadId: "pr-review:hook:pr-1542-fix" });
    expect(queue.claimThread(base.threadId).map((m) => m.id)).toEqual(["a1"]);
  });

  test("skips messages deferred into the future (not_before)", () => {
    const queue = q();
    queue.enqueue({ ...base, id: "d1" });
    queue.defer(["d1"], 5000); // deferred
    expect(queue.claimThread(base.threadId, 1000)).toEqual([]); // 1000 < 5000
    expect(queue.claimThread(base.threadId, 6000).map((m) => m.id)).toEqual(["d1"]); // ready
  });
});

describe("complete / defer / retry lifecycle", () => {
  test("complete marks terminal; readyThreadIds drops it", () => {
    const queue = q();
    queue.enqueue({ ...base, id: "d1" });
    queue.claimThread(base.threadId);
    queue.complete(["d1"], "done");
    expect(queue.readyThreadIds()).toEqual([]);
    expect(queue.list({ status: "done" }).length).toBe(1);
  });

  test("defer returns to pending, bumps attempts, sets not_before", () => {
    const queue = q();
    queue.enqueue({ ...base, id: "d1" });
    queue.claimThread(base.threadId);
    queue.defer(["d1"], 9999, "rate limited");
    const m = queue.list()[0];
    expect(m).toMatchObject({
      status: "pending",
      attempts: 1,
      notBefore: 9999,
      error: "rate limited",
    });
  });
});

describe("crash recovery + housekeeping", () => {
  test("requeueStuckRunning resets orphaned running → pending (replay)", () => {
    const queue = q();
    queue.enqueue({ ...base, id: "d1" });
    queue.claimThread(base.threadId); // now 'running' but worker 'died'
    expect(queue.requeueStuckRunning()).toBe(1);
    expect(queue.list()[0].status).toBe("pending");
    expect(queue.readyThreadIds()).toEqual([base.threadId]);
  });

  test("requeue() re-arms all failed messages (retry-every-failure)", () => {
    const queue = q();
    queue.enqueue({ ...base, id: "f1" });
    queue.enqueue({ ...base, id: "f2" });
    queue.enqueue({ ...base, id: "ok" });
    queue.claimThread(base.threadId);
    queue.complete(["f1", "f2"], "failed", "boom", "error");
    queue.complete(["ok"], "done");
    // bulk requeue: only the two failed flip back to pending
    expect(queue.requeue()).toBe(2);
    const byId = Object.fromEntries(queue.list().map((m) => [m.id, m]));
    expect(byId.f1).toMatchObject({ status: "pending", attempts: 0, notBefore: 0, error: null });
    expect(byId.f2.status).toBe("pending");
    expect(byId.ok.status).toBe("done"); // done untouched by bulk requeue
    expect(queue.readyThreadIds()).toEqual([base.threadId]);
  });

  test("requeue(ids) replays specific messages incl. done; ignores pending/running", () => {
    const queue = q();
    queue.enqueue({ ...base, id: "d1" });
    queue.enqueue({ ...base, id: "d2" });
    queue.enqueue({ ...base, id: "live" });
    queue.claimThread(base.threadId);
    queue.complete(["d1"], "failed", "boom", "error");
    queue.complete(["d2"], "done");
    // 'live' is still running (not completed) → not eligible
    expect(queue.requeue(["d1", "d2", "live", "nonexistent"])).toBe(2);
    const byId = Object.fromEntries(queue.list().map((m) => [m.id, m]));
    expect(byId.d1.status).toBe("pending");
    expect(byId.d2.status).toBe("pending"); // a done message CAN be replayed by id
    expect(byId.live.status).toBe("running"); // untouched
  });

  test("readyThreadIds is distinct across threads; pendingDepthByThread counts", () => {
    const queue = q();
    queue.enqueue({ ...base, id: "a1" });
    queue.enqueue({ ...base, id: "a2" });
    queue.enqueue({ ...base, id: "b1", threadId: "pr-review:hook:pr-1542-fix" });
    expect(queue.readyThreadIds().sort()).toEqual([
      "pr-comments:hook:pr-1542-fix",
      "pr-review:hook:pr-1542-fix",
    ]);
    expect(queue.pendingDepthByThread()).toEqual({
      "pr-comments:hook:pr-1542-fix": 2,
      "pr-review:hook:pr-1542-fix": 1,
    });
  });

  test("prune drops old done/failed but keeps pending", () => {
    const queue = q();
    queue.enqueue({ ...base, id: "old" });
    queue.claimThread(base.threadId);
    queue.complete(["old"], "done");
    queue.enqueue({ ...base, id: "fresh" });
    // prune everything terminal older than 0ms → drops 'old', keeps 'fresh' (pending)
    const removed = queue.prune(0, Date.now() + 1000);
    expect(removed).toBe(1);
    expect(queue.list().map((m) => m.id)).toEqual(["fresh"]);
  });
});

describe("listLatestPerThread (flood-proof sidebar snapshot)", () => {
  test("returns exactly one row per thread, newest-first; flood cannot crowd out other threads", () => {
    const queue = q();
    const now = Date.now();

    // Thread A: 50 rows (simulates the pr-accepted flood)
    for (let i = 0; i < 50; i++) {
      queue.enqueue({
        ...base,
        id: `a-${i}`,
        threadId: "pr-accepted:hook:pr-1542-fix",
        jobName: "pr-accepted",
        enqueuedAt: now + i,
      });
    }
    // Complete all A rows so updated_at is set distinctly; last one gets highest updated_at
    for (let i = 0; i < 50; i++) {
      queue.claimThread("pr-accepted:hook:pr-1542-fix", now + 1000 + i);
      queue.complete([`a-${i}`], "done");
    }

    // Thread B: 1 row (a different PR's routine)
    queue.enqueue({
      ...base,
      id: "b-1",
      threadId: "pr-comments:hook:pr-9-other",
      jobName: "pr-comments",
      scope: "pr-9-other",
      prNumber: 9,
      enqueuedAt: now + 10,
    });

    // Thread C: 1 row (yet another PR)
    queue.enqueue({
      ...base,
      id: "c-1",
      threadId: "pr-review:hook:pr-77-feature",
      jobName: "pr-review",
      scope: "pr-77-feature",
      prNumber: 77,
      enqueuedAt: now + 20,
    });

    const result = queue.listLatestPerThread(500);

    // Exactly 3 threads (A collapsed from 50 → 1)
    expect(result.length).toBe(3);

    // All three thread_ids present — B and C were NOT crowded out
    const threadIds = result.map((m) => m.threadId);
    expect(threadIds).toContain("pr-accepted:hook:pr-1542-fix");
    expect(threadIds).toContain("pr-comments:hook:pr-9-other");
    expect(threadIds).toContain("pr-review:hook:pr-77-feature");

    // The representative row for thread A is the newest (done, id a-49)
    const rowA = result.find((m) => m.threadId === "pr-accepted:hook:pr-1542-fix");
    expect(rowA?.id).toBe("a-49");
    expect(rowA?.status).toBe("done");
  });

  test("thread survives when its newest-updated row is NOT its highest-rowid row", () => {
    // Regression: an older row (lower rowid) can hold the newest updated_at
    // (claim/complete/defer bumps updated_at on existing rows). A per-column
    // MAX() join would look for a single row matching BOTH MAX(updated_at) and
    // MAX(rowid) — find none — and silently DROP the whole thread. The
    // correlated subquery must still return the genuinely-newest row.
    // enqueue() stamps updated_at from enqueuedAt, so we invert deterministically:
    const queue = q();
    queue.enqueue({ ...base, id: "r1", threadId: "T", enqueuedAt: 2000 }); // rowid 1, updated 2000
    queue.enqueue({ ...base, id: "r2", threadId: "T", enqueuedAt: 1000 }); // rowid 2, updated 1000
    // MAX(updated_at)=r1 but MAX(rowid)=r2 → the old join would drop thread T.
    const result = queue.listLatestPerThread(500);
    expect(result.length).toBe(1);
    expect(result[0]?.threadId).toBe("T");
    expect(result[0]?.id).toBe("r1"); // newest by updated_at, despite lower rowid
  });

  test("limit caps by THREADS not rows — 50 rows on one thread still counts as 1", () => {
    const queue = q();
    const now = Date.now();

    // 50 rows on thread A
    for (let i = 0; i < 50; i++) {
      queue.enqueue({
        ...base,
        id: `flood-${i}`,
        threadId: "pr-accepted:hook:pr-1-slug",
        jobName: "pr-accepted",
        enqueuedAt: now + i,
      });
    }
    // 1 row on thread B
    queue.enqueue({
      ...base,
      id: "other-1",
      threadId: "pr-comments:hook:pr-2-slug",
      jobName: "pr-comments",
      scope: "pr-2-slug",
      prNumber: 2,
      enqueuedAt: now + 100,
    });

    // limit=1 → returns only 1 thread (the most-recently-updated one)
    const limited = queue.listLatestPerThread(1);
    expect(limited.length).toBe(1);

    // limit=2 → both threads
    const both = queue.listLatestPerThread(2);
    expect(both.length).toBe(2);
  });
});

describe("keys/fields + agent outcome on the message", () => {
  test("enqueue stores keys+fields; complete records the agent outcome", () => {
    const queue = q();
    queue.enqueue({
      ...base,
      id: "k1",
      keys: { key1Label: "action", key1: "created", key2Label: "pr/branch", key2: "#1525" },
      fields: [{ label: "repo", value: "org/app" }],
    });
    let m = queue.list()[0];
    expect(m.keys).toEqual({
      key1Label: "action",
      key1: "created",
      key2Label: "pr/branch",
      key2: "#1525",
    });
    expect(m.fields).toEqual([{ label: "repo", value: "org/app" }]);
    expect(m.outcome).toBeNull();
    queue.claimThread(base.threadId);
    queue.complete(["k1"], "done", null, "pass");
    m = queue.list()[0];
    expect(m).toMatchObject({ status: "done", outcome: "pass" });
  });
});
