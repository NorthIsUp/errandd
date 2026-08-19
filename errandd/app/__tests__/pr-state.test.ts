import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { derivePrState } from "../../shared/prState";
import {
  __resetPrStatesForTest,
  getPrStates,
  initPrStateStore,
  prStateKey,
  recordPrState,
  recordPrStateFromWebhook,
} from "../pr-state";

/** Minimal `pull_request` webhook body. */
function prEvent(pr: Record<string, unknown>, repo = "teamclara/Clara_V1") {
  return { action: "synchronize", repository: { full_name: repo }, pull_request: pr };
}

describe("derivePrState", () => {
  test("open PR with clean merge state → open", () => {
    expect(derivePrState({ state: "open", merged: false, mergeable_state: "clean" })).toBe("open");
  });

  test("closed + merged → merged (merged wins over any merge state)", () => {
    expect(derivePrState({ state: "closed", merged: true, mergeable_state: "dirty" })).toBe("merged");
  });

  test("closed + not merged → closed", () => {
    expect(derivePrState({ state: "closed", merged: false })).toBe("closed");
  });

  test("open + dirty merge state → conflicted", () => {
    expect(derivePrState({ state: "open", merged: false, mergeable_state: "dirty" })).toBe("conflicted");
  });

  test("open + mergeable:false → conflicted (even when mergeable_state unknown)", () => {
    expect(derivePrState({ state: "open", mergeable: false, mergeable_state: "unknown" })).toBe("conflicted");
  });

  test("missing / odd payload → unknown", () => {
    expect(derivePrState(null)).toBe("unknown");
    expect(derivePrState({})).toBe("unknown");
    expect(derivePrState({ state: "weird" })).toBe("unknown");
  });
});

describe("recordPrStateFromWebhook / getPrStates", () => {
  beforeEach(() => __resetPrStatesForTest());

  test("stores state keyed by repo#number", () => {
    recordPrStateFromWebhook(prEvent({ number: 2320, state: "open", mergeable_state: "clean" }));
    expect(getPrStates()[prStateKey("teamclara/Clara_V1", 2320)]).toEqual({
      state: "open",
      mergeable: null,
    });
  });

  test("captures mergeable boolean when present", () => {
    recordPrStateFromWebhook(prEvent({ number: 7, state: "open", mergeable: true, mergeable_state: "clean" }));
    expect(getPrStates()[prStateKey("teamclara/Clara_V1", 7)]).toEqual({
      state: "open",
      mergeable: true,
    });
  });

  test("later merged event overwrites earlier open state", () => {
    recordPrStateFromWebhook(prEvent({ number: 42, state: "open", mergeable_state: "clean" }));
    recordPrStateFromWebhook(prEvent({ number: 42, state: "closed", merged: true }));
    expect(getPrStates()[prStateKey("teamclara/Clara_V1", 42)]?.state).toBe("merged");
  });

  test("an unclassifiable event does NOT clobber a known state", () => {
    recordPrStateFromWebhook(prEvent({ number: 99, state: "open", mergeable_state: "dirty" }));
    // e.g. a `labeled` event whose PR node lost its state field
    recordPrStateFromWebhook(prEvent({ number: 99 }));
    expect(getPrStates()[prStateKey("teamclara/Clara_V1", 99)]?.state).toBe("conflicted");
  });

  test("owner/name repo fallback when full_name absent", () => {
    recordPrStateFromWebhook({
      action: "opened",
      repository: { owner: { login: "teamclara" }, name: "Clara_V1" },
      pull_request: { number: 5, state: "open", mergeable_state: "clean" },
    });
    expect(getPrStates()[prStateKey("teamclara/Clara_V1", 5)]?.state).toBe("open");
  });

  test("non-PR / malformed payload → no-op, no throw", () => {
    expect(recordPrStateFromWebhook(null)).toBeNull();
    expect(recordPrStateFromWebhook({ repository: { full_name: "a/b" } })).toBeNull();
    expect(Object.keys(getPrStates())).toHaveLength(0);
  });
});

describe("durable pr-state store", () => {
  const dbPath = join(tmpdir(), `errandd-pr-state-${process.pid}.db`);

  afterEach(() => {
    __resetPrStatesForTest();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  test("states survive a restart (write-through + hydrate)", () => {
    initPrStateStore(dbPath);
    recordPrStateFromWebhook(prEvent({ number: 42, state: "closed", merged: true }));
    recordPrState("teamclara/Clara_V1", 7, { state: "conflicted", mergeable: false });

    // simulate the daemon restarting: drop the map + handle, then reopen the file
    __resetPrStatesForTest();
    expect(Object.keys(getPrStates())).toHaveLength(0);
    initPrStateStore(dbPath);

    const states = getPrStates();
    expect(states[prStateKey("teamclara/Clara_V1", 42)]).toEqual({
      state: "merged",
      mergeable: null,
    });
    expect(states[prStateKey("teamclara/Clara_V1", 7)]).toEqual({
      state: "conflicted",
      mergeable: false,
    });
  });

  test("a later event overwrites the persisted row", () => {
    initPrStateStore(dbPath);
    recordPrStateFromWebhook(prEvent({ number: 9, state: "open", mergeable_state: "dirty" }));
    recordPrStateFromWebhook(prEvent({ number: 9, state: "closed", merged: true }));

    __resetPrStatesForTest();
    initPrStateStore(dbPath);
    expect(getPrStates()[prStateKey("teamclara/Clara_V1", 9)]?.state).toBe("merged");
  });

  test("recording with no store initialized stays in-memory and never throws", () => {
    recordPrState("teamclara/Clara_V1", 1, { state: "open", mergeable: true });
    expect(getPrStates()[prStateKey("teamclara/Clara_V1", 1)]?.state).toBe("open");
  });
});
