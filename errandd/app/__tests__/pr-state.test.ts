import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchHook } from "../hooks/github";
import { derivePrState } from "../../shared/prState";
import {
  __resetPrStatesForTest,
  getPrStates,
  initPrStateStore,
  prStateKey,
  recordPrState,
  recordPrStateFromWebhook,
  subscribePrStates,
  getPrStateRevision,
  recordOpenPrStates,
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
    expect(derivePrState({ state: "closed", merged: true, mergeable_state: "dirty" })).toBe(
      "merged",
    );
  });

  test("closed + not merged → closed", () => {
    expect(derivePrState({ state: "closed", merged: false })).toBe("closed");
  });

  test("open + dirty merge state → conflicted", () => {
    expect(derivePrState({ state: "open", merged: false, mergeable_state: "dirty" })).toBe(
      "conflicted",
    );
  });

  test("open + mergeable:false → conflicted (even when mergeable_state unknown)", () => {
    expect(derivePrState({ state: "open", mergeable: false, mergeable_state: "unknown" })).toBe(
      "conflicted",
    );
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
    recordPrStateFromWebhook(
      prEvent({ number: 7, state: "open", mergeable: true, mergeable_state: "clean" }),
    );
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

  test("a delayed open event cannot reopen a merged PR", () => {
    recordPrStateFromWebhook(prEvent({ number: 42, state: "closed", merged: true }));
    recordPrStateFromWebhook(prEvent({ number: 42, state: "open", merged: false }));
    expect(getPrStates()[prStateKey("teamclara/Clara_V1", 42)]?.state).toBe("merged");
  });

  test("webhook state is recorded even without configured routine dispatch", async () => {
    await dispatchHook(
      "pull_request",
      prEvent({ number: 4498, state: "closed", merged: true }),
      "merged",
      {},
    );
    expect(getPrStates()[prStateKey("teamclara/Clara_V1", 4498)]?.state).toBe("merged");
  });

  test("an older close replay cannot overwrite a newer reopened webhook", () => {
    recordPrStateFromWebhook(
      prEvent({ number: 4498, state: "closed", updated_at: "2026-10-30T12:00:00Z" }),
    );
    recordPrStateFromWebhook(
      prEvent({ number: 4498, state: "open", updated_at: "2026-10-31T12:00:00Z" }),
    );
    recordPrStateFromWebhook(
      prEvent({ number: 4498, state: "closed", updated_at: "2026-10-30T12:00:00Z" }),
    );
    expect(getPrStates()[prStateKey("teamclara/Clara_V1", 4498)]?.state).toBe("open");
  });

  test("missing or invalid source dates do not undo versioned evidence, but a merged fact remains terminal", () => {
    recordPrStateFromWebhook(
      prEvent({ number: 4498, state: "open", updated_at: "2026-10-31T12:00:00Z" }),
    );
    recordPrStateFromWebhook(prEvent({ number: 4498, state: "closed" }));
    recordPrStateFromWebhook(prEvent({ number: 4498, state: "closed", updated_at: "invalid" }));
    expect(getPrStates()[prStateKey("teamclara/Clara_V1", 4498)]?.state).toBe("open");
    recordPrStateFromWebhook(prEvent({ number: 4498, state: "closed", merged: true }));
    expect(getPrStates()[prStateKey("teamclara/Clara_V1", 4498)]?.state).toBe("merged");
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

describe("PR state publication", () => {
  beforeEach(() => __resetPrStatesForTest());
  afterEach(() => __resetPrStatesForTest());

  test("one merged webhook updates every subscribed view despite a stale open poll", async () => {
    const key = prStateKey("teamclara/Clara_V1", 4498);
    const original: (string | undefined)[] = [];
    const mirror: (string | undefined)[] = [];
    recordOpenPrStates(
      [{ repo: "teamclara/Clara_V1", number: 4498, isDraft: false }],
      getPrStateRevision(),
    );
    const startedRevision = getPrStateRevision();
    const read = () => getPrStates()[key]?.state;
    const stopOriginal = subscribePrStates(() => original.push(read()));
    const stopMirror = subscribePrStates(() => mirror.push(read()));
    expect(original).toEqual(["open"]);
    expect(mirror).toEqual(["open"]);
    await dispatchHook(
      "pull_request",
      prEvent({ number: 4498, state: "closed", merged: true }),
      "merge",
      {},
    );
    recordOpenPrStates(
      [{ repo: "teamclara/Clara_V1", number: 4498, isDraft: false }],
      startedRevision,
    );
    expect(original).toEqual(["open", "merged"]);
    expect(mirror).toEqual(["open", "merged"]);
    stopOriginal();
    stopMirror();
    recordPrState("teamclara/Clara_V1", 2, { state: "open", mergeable: true });
    expect(original).toHaveLength(2);
    expect(mirror).toHaveLength(2);
  });

  test("subscriber failures are isolated and equivalent states do not republish", () => {
    const observed: number[] = [];
    subscribePrStates(() => {
      throw Error("disconnected");
    });
    const stop = subscribePrStates(() => observed.push(Object.keys(getPrStates()).length));
    recordPrState("example/repo", 1, { state: "merged", mergeable: null });
    recordPrState("example/repo", 1, { state: "merged", mergeable: null });
    recordPrState("example/repo", 1, { state: "open", mergeable: true });
    expect(observed).toEqual([0, 1]);
    stop();
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

  test("upstream ordering watermarks survive reloads independently of receipt retention", () => {
    initPrStateStore(dbPath);
    recordPrStateFromWebhook(
      prEvent({ number: 4498, state: "open", updated_at: "2026-10-31T12:00:00Z" }),
    );
    __resetPrStatesForTest();
    initPrStateStore(dbPath);
    recordPrStateFromWebhook(
      prEvent({ number: 4498, state: "closed", updated_at: "2026-10-30T12:00:00Z" }),
    );
    expect(getPrStates()[prStateKey("teamclara/Clara_V1", 4498)]?.state).toBe("open");
  });

  test("legacy state tables gain a nullable source watermark without changing receipt TTL", () => {
    const legacy = new Database(dbPath);
    legacy.exec(
      "CREATE TABLE pr_state (key TEXT PRIMARY KEY, state TEXT NOT NULL, mergeable INTEGER, updated_at INTEGER NOT NULL)",
    );
    legacy.run("INSERT INTO pr_state VALUES (?, ?, ?, ?)", [
      prStateKey("teamclara/Clara_V1", 4498),
      "closed",
      null,
      Date.now(),
    ]);
    legacy.close();
    initPrStateStore(dbPath);
    expect(getPrStates()[prStateKey("teamclara/Clara_V1", 4498)]?.state).toBe("closed");
    recordPrStateFromWebhook(
      prEvent({ number: 4498, state: "open", updated_at: "2026-10-31T12:00:00Z" }),
    );
    __resetPrStatesForTest();
    initPrStateStore(dbPath);
    recordPrStateFromWebhook(
      prEvent({ number: 4498, state: "closed", updated_at: "2026-10-30T12:00:00Z" }),
    );
    expect(getPrStates()[prStateKey("teamclara/Clara_V1", 4498)]?.state).toBe("open");
  });

  test("recording with no store initialized stays in-memory and never throws", () => {
    recordPrState("teamclara/Clara_V1", 1, { state: "open", mergeable: true });
    expect(getPrStates()[prStateKey("teamclara/Clara_V1", 1)]?.state).toBe("open");
  });
});
