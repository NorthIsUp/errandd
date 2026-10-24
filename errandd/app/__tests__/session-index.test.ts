import { expect, test } from "bun:test";
import { indexedSessions, storeSessionIndex, updateIndexedSession } from "../ui/services/sessionIndex";
import type { SessionInfo } from "../ui/services/sessions";

test("SQL session index pages recent runs, filters closed sessions and updates metadata immediately", () => {
  const sessions: SessionInfo[] = Array.from({ length: 12 }, (_, index) => ({
    id: `session-index-${index}`, agent: "review", channel: "job", closed: index === 11,
    lastUsedAt: new Date(1700000000000 + index * 1000).toISOString(),
    createdAt: new Date(1700000000000).toISOString(), turnCount: index,
    firstMessage: "Inspect this change", lastMessage: "Tests passed",
  }));
  storeSessionIndex(sessions);
  expect(indexedSessions(false, 2).map(session => session.id)).toEqual(["session-index-10", "session-index-9"]);
  expect(indexedSessions(true, 2, 1).map(session => session.id)).toEqual(["session-index-10", "session-index-9"]);
  updateIndexedSession("session-index-10", session => ({ ...session, closed: true, title: "Reviewed" }));
  expect(indexedSessions(false, 1)[0].id).toBe("session-index-9");
  expect(indexedSessions(true).find(session => session.id === "session-index-10")?.title).toBe("Reviewed");
  storeSessionIndex(sessions.slice(0, 3));
  expect(indexedSessions(true)).toHaveLength(3);
  storeSessionIndex([]);
});
