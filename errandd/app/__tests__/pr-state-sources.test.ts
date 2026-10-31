import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { derivePrState, derivePrStateFromGraphql } from "../../shared/prState";
import {
  __resetPrStatesForTest,
  getPrStates,
  getPrStateRevision,
  prStateKey,
  recordOpenPrStates,
  recordPrState,
  recordPrStateFromWebhook,
  subscribePrStates,
} from "../pr-state";

describe("draft PRs", () => {
  test("webhook: open + draft → draft", () => {
    expect(derivePrState({ state: "open", draft: true, mergeable_state: "clean" })).toBe("draft");
  });

  test("webhook: draft outranks a dirty merge state (a draft isn't actionable)", () => {
    expect(derivePrState({ state: "open", draft: true, mergeable_state: "dirty" })).toBe("draft");
  });

  test("webhook: a merged PR is never re-read as draft", () => {
    expect(derivePrState({ state: "closed", merged: true, draft: true })).toBe("merged");
  });
});

describe("derivePrStateFromGraphql", () => {
  test("MERGED is a first-class state (REST splits it into closed + merged)", () => {
    expect(derivePrStateFromGraphql({ state: "MERGED" })).toBe("merged");
  });

  test("CLOSED → closed", () => {
    expect(derivePrStateFromGraphql({ state: "CLOSED", mergeable: "CONFLICTING" })).toBe("closed");
  });

  test("OPEN + CONFLICTING → conflicted", () => {
    expect(derivePrStateFromGraphql({ state: "OPEN", mergeable: "CONFLICTING" })).toBe(
      "conflicted",
    );
  });

  test("OPEN + isDraft → draft", () => {
    expect(derivePrStateFromGraphql({ state: "OPEN", isDraft: true })).toBe("draft");
  });

  test("OPEN + UNKNOWN mergeability → open (mergeability is computed async)", () => {
    expect(derivePrStateFromGraphql({ state: "OPEN", mergeable: "UNKNOWN" })).toBe("open");
  });

  test("a missing node (deleted / no access) → unknown", () => {
    expect(derivePrStateFromGraphql(null)).toBe("unknown");
    expect(derivePrStateFromGraphql({})).toBe("unknown");
  });
});

describe("canonical PR observations", () => {
  const repo = "teamclara/Clara_V1";
  const key = prStateKey(repo, 4498);
  const open = (isDraft = false) => [{ repo, number: 4498, isDraft }];
  beforeEach(__resetPrStatesForTest);
  afterEach(__resetPrStatesForTest);

  test("a cached open snapshot cannot override a newer closed webhook", () => {
    recordOpenPrStates(open(), getPrStateRevision());
    const startedRevision = getPrStateRevision();
    recordPrStateFromWebhook({
      repository: { full_name: repo },
      pull_request: { number: 4498, state: "closed", merged: false },
    });
    recordOpenPrStates(open(), startedRevision);
    expect(getPrStates()[key]?.state).toBe("closed");
  });

  test("a later fresh poll can legitimately reopen a closed PR", () => {
    recordPrState(repo, 4498, { state: "closed", mergeable: false });
    recordOpenPrStates(open(), getPrStateRevision());
    expect(getPrStates()[key]).toEqual({ state: "open", mergeable: null });
  });

  test("merged never reopens even under a fresh open-list observation", () => {
    recordPrState(repo, 4498, { state: "merged", mergeable: null });
    recordOpenPrStates(open(), getPrStateRevision());
    expect(getPrStates()[key]?.state).toBe("merged");
  });

  test("draft and ready transitions come from fresh discovery", () => {
    recordOpenPrStates(open(true), getPrStateRevision());
    expect(getPrStates()[key]?.state).toBe("draft");
    recordOpenPrStates(open(false), getPrStateRevision());
    expect(getPrStates()[key]?.state).toBe("open");
  });

  test("the open list cannot erase conflict evidence it does not contain", () => {
    recordPrState(repo, 4498, { state: "conflicted", mergeable: false });
    recordOpenPrStates(open(), getPrStateRevision());
    expect(getPrStates()[key]).toEqual({ state: "conflicted", mergeable: false });
  });

  test("unrelated webhook activity does not invalidate another PR's observation", () => {
    recordOpenPrStates(open(), getPrStateRevision());
    const startedRevision = getPrStateRevision();
    recordPrState(repo, 4500, { state: "merged", mergeable: null });
    recordOpenPrStates(open(true), startedRevision);
    expect(getPrStates()[key]?.state).toBe("draft");
  });

  test("a late backfill cannot overwrite a newer webhook for the same PR", () => {
    recordOpenPrStates(open(), getPrStateRevision());
    const startedRevision = getPrStateRevision();
    recordPrState(repo, 4498, { state: "draft", mergeable: true });
    recordPrState(repo, 4498, { state: "closed", mergeable: null }, startedRevision);
    expect(getPrStates()[key]?.state).toBe("draft");
  });

  test("cached discovery seeds missing identities without replacing persisted observations", () => {
    recordPrState(repo, 4498, { state: "closed", mergeable: null });
    recordOpenPrStates([...open(), { repo, number: 4500, isDraft: true }], 0);
    expect(getPrStates()[key]?.state).toBe("closed");
    expect(getPrStates()[prStateKey(repo, 4500)]?.state).toBe("draft");
  });

  test("a complete poll publishes one coherent batch and an empty batch clears nothing", () => {
    const snapshots: ReturnType<typeof getPrStates>[] = [];
    subscribePrStates(() => snapshots.push(getPrStates()));
    recordOpenPrStates([...open(), { repo, number: 4500, isDraft: true }], getPrStateRevision());
    expect(snapshots).toHaveLength(2);
    expect(Object.keys(snapshots[1])).toHaveLength(2);
    recordPrState(repo, 4498, { state: "merged", mergeable: null });
    const previous = getPrStates();
    recordOpenPrStates([], getPrStateRevision());
    expect(getPrStates()).toEqual(previous);
    expect(snapshots).toHaveLength(3);
  });
});
