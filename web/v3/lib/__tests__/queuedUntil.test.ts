import { describe, expect, test } from "bun:test";
import type { QueueMessage } from "../../../api/hooks";
import {
  deferredCount,
  deferredUntilForThread,
  fmtUtcHM,
  isDeferred,
} from "../queuedUntil";

function msg(over: Partial<QueueMessage> & { id: string }): QueueMessage {
  return {
    threadId: "t1",
    jobName: "j",
    event: "pull_request",
    scope: "pr-1",
    enqueuedAt: 0,
    status: "pending",
    attempts: 0,
    notBefore: 0,
    prRepo: null,
    prNumber: null,
    error: null,
    updatedAt: 0,
    ...over,
  };
}

const NOW = 1_000_000;

describe("isDeferred", () => {
  test("pending + future notBefore ⇒ deferred", () => {
    expect(isDeferred(msg({ id: "a", status: "pending", notBefore: NOW + 1000 }), NOW)).toBe(true);
  });
  test("past notBefore ⇒ not deferred", () => {
    expect(isDeferred(msg({ id: "b", status: "pending", notBefore: NOW - 1000 }), NOW)).toBe(false);
  });
  test("running/done are never deferred", () => {
    expect(isDeferred(msg({ id: "c", status: "running", notBefore: NOW + 1000 }), NOW)).toBe(false);
    expect(isDeferred(msg({ id: "d", status: "done", notBefore: NOW + 1000 }), NOW)).toBe(false);
  });
});

describe("deferredUntilForThread", () => {
  test("earliest future notBefore among a thread's deferred rows", () => {
    const rows = [
      msg({ id: "1", threadId: "t1", notBefore: NOW + 5000 }),
      msg({ id: "2", threadId: "t1", notBefore: NOW + 2000 }),
      msg({ id: "3", threadId: "t2", notBefore: NOW + 1000 }),
    ];
    expect(deferredUntilForThread(rows, "t1", NOW)).toBe(NOW + 2000);
    expect(deferredUntilForThread(rows, "t2", NOW)).toBe(NOW + 1000);
  });
  test("0 when the thread has no deferred rows", () => {
    expect(deferredUntilForThread([msg({ id: "1", status: "done" })], "t1", NOW)).toBe(0);
  });
});

describe("deferredCount", () => {
  test("counts only currently-deferred rows", () => {
    const rows = [
      msg({ id: "1", notBefore: NOW + 1000 }),
      msg({ id: "2", notBefore: NOW + 1000 }),
      msg({ id: "3", status: "running", notBefore: NOW + 1000 }),
      msg({ id: "4", notBefore: NOW - 1 }),
    ];
    expect(deferredCount(rows, NOW)).toBe(2);
  });
});

describe("fmtUtcHM", () => {
  test("formats epoch ms as HH:MM UTC", () => {
    // 2026-06-09T14:05:00Z
    const ms = Date.UTC(2026, 5, 9, 14, 5, 0);
    expect(fmtUtcHM(ms)).toBe("14:05 UTC");
  });
});
