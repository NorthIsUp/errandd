import { expect, test } from "bun:test";
import { applyPrPoll, type PrSidebarSnapshot } from "../prSnapshot";

const key = "teamclara/Clara_V1#4498";
test("a late open-list response cannot revert a streamed merged snapshot", () => {
  const current: PrSidebarSnapshot = {
    prs: [],
    fetchedAt: 0,
    states: { [key]: { state: "merged", mergeable: null } },
    stateRevision: 1,
  };
  const updated = applyPrPoll(
    current,
    { prs: [], fetchedAt: 123, states: { [key]: { state: "open", mergeable: true } } },
    0,
  );
  expect(updated.fetchedAt).toBe(123);
  expect(updated.states).toBe(current.states);
  expect(updated.states[key]?.state).toBe("merged");
});

test("a poll begun after the live snapshot can refresh ordinary states", () => {
  const current: PrSidebarSnapshot = {
    prs: [],
    fetchedAt: 0,
    states: { [key]: { state: "closed", mergeable: null } },
    stateRevision: 1,
  };
  const updated = applyPrPoll(
    current,
    { prs: [], fetchedAt: 123, states: { [key]: { state: "open", mergeable: true } } },
    1,
  );
  expect(updated.states[key]?.state).toBe("open");
});
