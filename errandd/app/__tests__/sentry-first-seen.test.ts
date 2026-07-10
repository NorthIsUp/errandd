import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Job } from "../jobs";
import { handleSentryWebhook } from "../hooks/sentry";
import { parseTriggers } from "../hooks/schema";
import {
  __resetSentrySeenStoreForTests,
  hasSeenIssue,
  initSentrySeenStore,
  markIssueSeen,
  pruneSentrySeen,
} from "../hooks/sentrySeen";

let seq = 0;
function tmpPath(): string {
  return `/tmp/errandd-sentry-seen-${process.pid}-${seq++}.db`;
}

describe("sentrySeen store", () => {
  afterEach(() => __resetSentrySeenStoreForTests());

  test("markIssueSeen returns firstSeen=true exactly once per id", () => {
    initSentrySeenStore(tmpPath());
    expect(markIssueSeen("55")).toEqual({ firstSeen: true });
    expect(markIssueSeen("55")).toEqual({ firstSeen: false });
    expect(markIssueSeen("55")).toEqual({ firstSeen: false });
    expect(hasSeenIssue("55")).toBe(true);
  });

  test("two ids are independent", () => {
    initSentrySeenStore(tmpPath());
    expect(markIssueSeen("a").firstSeen).toBe(true);
    expect(markIssueSeen("b").firstSeen).toBe(true);
    expect(markIssueSeen("a").firstSeen).toBe(false);
    expect(markIssueSeen("b").firstSeen).toBe(false);
  });

  test("empty issue id is never recorded", () => {
    initSentrySeenStore(tmpPath());
    expect(markIssueSeen("")).toEqual({ firstSeen: false });
    expect(hasSeenIssue("")).toBe(false);
  });

  test("uninitialized store fails open (firstSeen=true)", () => {
    // No init → the gate must NOT silently suppress a triage.
    expect(markIssueSeen("99")).toEqual({ firstSeen: true });
    expect(hasSeenIssue("99")).toBe(false);
  });

  test("prune drops old rows, keeps recent ones", () => {
    const path = tmpPath();
    initSentrySeenStore(path);
    markIssueSeen("old");
    markIssueSeen("recent");
    // Backdate "old" 200 days into the past via a raw handle on the same file.
    const raw = new Database(path);
    const longAgo = Date.now() - 200 * 24 * 60 * 60 * 1000;
    raw.run("UPDATE sentry_seen SET first_seen_at = ? WHERE issue_id = ?", [longAgo, "old"]);
    raw.close();

    const dropped = pruneSentrySeen(90 * 24 * 60 * 60 * 1000);
    expect(dropped).toBe(1);
    expect(hasSeenIssue("old")).toBe(false);
    expect(hasSeenIssue("recent")).toBe(true);
  });
});

// --- dispatch gate -----------------------------------------------------------

const SENTRY_ISSUE = {
  action: "created",
  data: {
    issue: {
      id: "55",
      shortId: "CLARA-BACKEND-T1",
      title: "TypeError: undefined is not a function",
      level: "error",
      project: { slug: "clara-prod" },
      permalink: "https://sentry.io/issues/55/",
    },
  },
};

function makeJob(name: string, on: unknown[]): Job {
  const { schedules, hookConfig } = parseTriggers(on, undefined);
  return {
    name,
    schedules,
    prompt: "x",
    recurring: false,
    notify: true,
    reuseSession: false,
    ...(hookConfig ? { hookConfig } : {}),
  };
}

function sentryRequest(): Request {
  return new Request("http://local/api/webhooks/sentry", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sentry-hook-resource": "issue",
      // Unique request-id per call so the delivery-ring TTL dedup doesn't mark
      // the second delivery a duplicate (we want the first-seen gate to decide).
      "request-id": `sentry-fs-${process.pid}-${seq++}`,
    },
    body: JSON.stringify(SENTRY_ISSUE),
  });
}

interface FireCall {
  job: string;
  opts?: { notBefore?: number };
}

describe("sentry first-seen dispatch gate", () => {
  beforeEach(() => initSentrySeenStore(tmpPath()));
  afterEach(() => __resetSentrySeenStoreForTests());

  test("firstSeen rule fires on a brand-new issue, skips on a repeat", async () => {
    const fires: FireCall[] = [];
    const deps = {
      getJobs: () => [makeJob("triage", [{ sentry: { firstSeen: true } }])],
      onHookFire: (job: string, _e: string, _id: string, _p: unknown, opts?: { notBefore?: number }) => {
        fires.push({ job, opts });
      },
    };

    const first = await handleSentryWebhook(sentryRequest(), deps);
    expect(first.body).toMatchObject({ ok: true, matched: ["triage"] });
    expect(fires.map((f) => f.job)).toEqual(["triage"]);

    // Same issue id, fresh delivery id → already triaged → no enqueue.
    const second = await handleSentryWebhook(sentryRequest(), deps);
    expect((second.body as { matched?: string[] }).matched).toBeUndefined();
    expect(fires.length).toBe(1); // still just the first fire
  });

  test("two firstSeen jobs BOTH fire on the first occurrence", async () => {
    const fires: string[] = [];
    const deps = {
      getJobs: () => [
        makeJob("triage-a", [{ sentry: { firstSeen: true } }]),
        makeJob("triage-b", [{ sentry: { firstSeen: true } }]),
      ],
      onHookFire: (job: string) => {
        fires.push(job);
      },
    };
    const res = await handleSentryWebhook(sentryRequest(), deps);
    expect((res.body as { matched?: string[] }).matched?.sort()).toEqual(["triage-a", "triage-b"]);
    expect(fires.sort()).toEqual(["triage-a", "triage-b"]);
  });

  test("debounceMs sets a future notBefore on the enqueue", async () => {
    const fires: FireCall[] = [];
    const deps = {
      getJobs: () => [makeJob("debounced", [{ sentry: { debounceMs: 5000 } }])],
      onHookFire: (job: string, _e: string, _id: string, _p: unknown, opts?: { notBefore?: number }) => {
        fires.push({ job, opts });
      },
    };
    const before = Date.now();
    await handleSentryWebhook(sentryRequest(), deps);
    expect(fires.length).toBe(1);
    const nb = fires[0]?.opts?.notBefore;
    expect(nb).toBeGreaterThanOrEqual(before + 5000);
    expect(nb).toBeLessThanOrEqual(Date.now() + 5000);
  });

  test("no-debounce rule enqueues with no notBefore", async () => {
    const fires: FireCall[] = [];
    const deps = {
      getJobs: () => [makeJob("plain", [{ sentry: true }])],
      onHookFire: (job: string, _e: string, _id: string, _p: unknown, opts?: { notBefore?: number }) => {
        fires.push({ job, opts });
      },
    };
    await handleSentryWebhook(sentryRequest(), deps);
    expect(fires.length).toBe(1);
    expect(fires[0]?.opts).toBeUndefined();
  });
});
