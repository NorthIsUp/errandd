import { expect, test } from "bun:test";
import { applyPrPoll, applyPrStateSnapshot, type PrSidebarSnapshot } from "../prSnapshot";

const key = "teamclara/Clara_V1#4498";
const initial = (): PrSidebarSnapshot => ({
  prs: [],
  fetchedAt: 0,
  states: {},
  stateVersion: { epochMs: 100, revision: 0 },
});
const snapshot = (state: "open" | "merged" | "closed", revision: number, epochMs = 100) => ({
  states: { [key]: { state, mergeable: null } },
  stateVersion: { epochMs, revision },
});

test("a late open-list response cannot revert a streamed merged snapshot", () => {
  const current = applyPrStateSnapshot(initial(), snapshot("merged", 2));
  const updated = applyPrPoll(current, { prs: [], fetchedAt: 123, ...snapshot("open", 1) });
  expect(updated.fetchedAt).toBe(123);
  expect(updated.states).toBe(current.states);
  expect(updated.states[key]?.state).toBe("merged");
});

test("buffered SSE cannot revert a newer HTTP observation", () => {
  const current = applyPrPoll(initial(), { prs: [], fetchedAt: 123, ...snapshot("closed", 2) });
  const updated = applyPrStateSnapshot(current, snapshot("open", 1));
  expect(updated).toBe(current);
  expect(updated.states[key]?.state).toBe("closed");
});

test("a genuinely newer observation can reopen a closed PR", () => {
  const current = applyPrStateSnapshot(initial(), snapshot("closed", 2));
  expect(
    applyPrPoll(current, { prs: [], fetchedAt: 123, ...snapshot("open", 3) }).states[key]?.state,
  ).toBe("open");
});

test("a new daemon epoch accepts reset revisions and rejects late old-epoch frames", () => {
  const current = applyPrStateSnapshot(initial(), snapshot("open", 500));
  const restarted = applyPrStateSnapshot(current, snapshot("closed", 1, 200));
  expect(restarted.states[key]?.state).toBe("closed");
  expect(applyPrStateSnapshot(restarted, snapshot("open", 501))).toBe(restarted);
});

test("legacy discovery can load before live state but cannot overwrite it", () => {
  const empty = { ...initial(), stateVersion: { epochMs: 0, revision: 0 } };
  const poll = { prs: [], fetchedAt: 123, states: snapshot("open", 1).states };
  expect(applyPrPoll(empty, poll).states[key]?.state).toBe("open");
  const live = applyPrStateSnapshot(empty, snapshot("merged", 2));
  expect(applyPrPoll(live, poll).states[key]?.state).toBe("merged");
});
