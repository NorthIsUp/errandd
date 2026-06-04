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
