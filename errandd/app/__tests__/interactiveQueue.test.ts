import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InteractiveQueue, queuedReply } from "../messaging/interactiveQueue";

function freshQueue(): InteractiveQueue {
  return new InteractiveQueue(join(tmpdir(), `iq-test-${Date.now()}-${Math.random()}.db`));
}

describe("InteractiveQueue (durable rate-limit message queue)", () => {
  test("enqueue → claimReady → complete lifecycle", () => {
    const q = freshQueue();
    const id = q.enqueue({
      platform: "telegram",
      chatId: "12345",
      threadTs: "67",
      userId: "9",
      sessionKey: "tg:12345:67",
      text: "[Telegram from u] Message: hi",
    });
    expect(q.pendingCount()).toBe(1);

    const [m] = q.claimReady();
    expect(m.id).toBe(id);
    expect(m.platform).toBe("telegram");
    expect(m.chatId).toBe("12345");
    expect(m.threadTs).toBe("67");
    expect(m.sessionKey).toBe("tg:12345:67");
    // Claimed → running → no longer pending.
    expect(q.pendingCount()).toBe(0);

    q.complete(m.id, "done");
    expect(q.list({ status: "done" }).length).toBe(1);
    q.close();
  });

  test("defer holds a message until notBefore, then it re-claims", () => {
    const q = freshQueue();
    const id = q.enqueue({ platform: "discord", chatId: "chan1", text: "hi" });
    const [m] = q.claimReady();
    q.defer(m.id, Date.now() + 10_000, "exit 1");
    // Not ready now…
    expect(q.pendingCount()).toBe(0);
    expect(q.claimReady().length).toBe(0);
    // …but ready in the future (and attempts bumped).
    const future = Date.now() + 20_000;
    expect(q.pendingCount(future)).toBe(1);
    const [again] = q.claimReady(future);
    expect(again.id).toBe(id);
    expect(again.attempts).toBe(1);
    q.close();
  });

  test("requeueStuckRunning replays a message left running by a crash", () => {
    const q = freshQueue();
    q.enqueue({ platform: "slack", chatId: "C1", threadTs: "1.1", text: "hi" });
    q.claimReady(); // now 'running'
    expect(q.pendingCount()).toBe(0);
    expect(q.requeueStuckRunning()).toBe(1);
    expect(q.pendingCount()).toBe(1); // back to pending → replays on next drain
    q.close();
  });

  test("prune drops terminal rows older than the ttl", () => {
    const q = freshQueue();
    const id = q.enqueue({ platform: "telegram", chatId: "1", text: "hi" });
    q.claimReady();
    q.complete(id, "failed", "boom");
    // Prune with `now` 1s in the future so the just-completed row is older than
    // the (1ms) ttl window and gets dropped.
    expect(q.prune(1, Date.now() + 1000)).toBe(1);
    expect(q.list().length).toBe(0);
    q.close();
  });

  test("queuedReply formats the reset time as HH:MM UTC", () => {
    expect(queuedReply(Date.UTC(2026, 0, 1, 15, 30))).toBe(
      "Queued — I'll respond after the limit resets at 03:30 PM UTC.",
    );
  });
});
