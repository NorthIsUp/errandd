import { describe, expect, test } from "bun:test";
import { findClobberCandidates } from "../maintenance/recoverClobberedThreads";
import type { LogEntry, ThreadSession } from "../sessionManager";

function sess(threadId: string, sessionId: string, turnCount: number): LogEntry {
  const s: ThreadSession = {
    sessionId,
    threadId,
    createdAt: "2026-06-09T20:00:00.000Z",
    lastUsedAt: "2026-06-09T21:00:00.000Z",
    turnCount,
    compactWarned: false,
  };
  return { threadId, session: s };
}
const del = (threadId: string): LogEntry => ({ threadId, deleted: true });

describe("findClobberCandidates", () => {
  test("detects a real session superseded by a turnCount-0 placeholder", () => {
    const c = findClobberCandidates([
      sess("t", "REAL", 5),
      sess("t", "SKIP", 0), // clobber
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]?.threadId).toBe("t");
    expect(c[0]?.placeholderSessionId).toBe("SKIP");
    expect(c[0]?.real.sessionId).toBe("REAL");
    expect(c[0]?.real.turnCount).toBe(5);
  });

  test("a thread that only ever skipped (no prior real session) is NOT a candidate", () => {
    expect(findClobberCandidates([sess("t", "SKIP", 0)])).toHaveLength(0);
  });

  test("a healthy thread (current has turns) is NOT a candidate", () => {
    expect(findClobberCandidates([sess("t", "REAL", 5)])).toHaveLength(0);
    // even with an earlier session, if the CURRENT one is real, leave it
    expect(
      findClobberCandidates([sess("t", "OLD", 2), sess("t", "NEW", 3)]),
    ).toHaveLength(0);
  });

  test("recovers to the MOST RECENT earlier real session", () => {
    const c = findClobberCandidates([
      sess("t", "REAL1", 2),
      sess("t", "REAL2", 7),
      sess("t", "SKIP", 0),
    ]);
    expect(c[0]?.real.sessionId).toBe("REAL2");
  });

  test("ignores the placeholder's own earlier 0-turn line (needs a DIFFERENT real session)", () => {
    // createThreadSession writes turnCount 0 first; a real session then increments.
    // A placeholder that is its own only history → nothing to recover.
    expect(
      findClobberCandidates([sess("t", "SKIP", 0), sess("t", "SKIP", 0)]),
    ).toHaveLength(0);
  });

  test("a tombstoned (deleted) thread is skipped even if it had a real session", () => {
    expect(
      findClobberCandidates([sess("t", "REAL", 5), sess("t", "SKIP", 0), del("t")]),
    ).toHaveLength(0);
  });

  test("independent threads are handled independently", () => {
    const c = findClobberCandidates([
      sess("a", "AR", 3),
      sess("a", "AS", 0), // clobbered
      sess("b", "BR", 4), // healthy
    ]);
    expect(c.map((x) => x.threadId)).toEqual(["a"]);
  });
});
