import { describe, expect, test } from "bun:test";
import type { QueueMessage } from "../../../api/hooks";
import { buildTree, mergePolledPRs, sourceForEvent, type PolledPR, type TreeItem } from "../tree";

/**
 * The sidebar tree is built entirely client-side from the durable hook queue.
 * These exercise the sentry/datadog path specifically: classification
 * (`sourceForEvent`) plus subject keying + titling (`itemFor`, via
 * `buildTree`) — the bug being that sentry/datadog rows used to key on the
 * level/priority, collapsing distinct issues/monitors into one row.
 */

function msg(over: Partial<QueueMessage>): QueueMessage {
  return {
    id: "id-1",
    threadId: "job:hook:scope",
    jobName: "triage",
    event: "pull_request",
    scope: "scope",
    enqueuedAt: 1000,
    status: "done",
    attempts: 0,
    notBefore: 0,
    prRepo: null,
    prNumber: null,
    outcome: "ok",
    error: null,
    updatedAt: 1000,
    ...over,
  };
}

describe("sourceForEvent", () => {
  test("classifies sentry / datadog / github / routines", () => {
    expect(sourceForEvent(msg({ event: "sentry:issue" }))).toBe("sentry");
    expect(sourceForEvent(msg({ event: "sentry:event_alert" }))).toBe("sentry");
    expect(sourceForEvent(msg({ event: "datadog:alert" }))).toBe("datadog");
    expect(sourceForEvent(msg({ event: "pull_request" }))).toBe("github");
    expect(sourceForEvent(msg({ event: "web:message" }))).toBe("routines");
  });
});

function section(tree: ReturnType<typeof buildTree>, source: string) {
  const s = tree.find((sec) => sec.source === source);
  if (!s) {
    throw new Error(`no section ${source}`);
  }
  return s;
}

describe("buildTree — sentry", () => {
  test("keys each issue by its scope (not by level) and titles by issue text", () => {
    const tree = buildTree([
      msg({
        id: "s1",
        jobName: "triage",
        event: "sentry:issue",
        scope: "sentry-issue-1001",
        threadId: "triage:hook:sentry-issue-1001",
        keys: { key1Label: "level", key1: "error", key2Label: "action", key2: "created" },
        fields: [
          { label: "project", value: "backend" },
          { label: "level", value: "error" },
          { label: "issue", value: "TypeError: cannot read x of undefined" },
        ],
      }),
      // Same level ("error") but a DIFFERENT issue → must be a separate item.
      msg({
        id: "s2",
        jobName: "triage",
        event: "sentry:issue",
        scope: "sentry-issue-2002",
        threadId: "triage:hook:sentry-issue-2002",
        keys: { key1Label: "level", key1: "error", key2Label: "action", key2: "created" },
        fields: [
          { label: "project", value: "backend" },
          { label: "issue", value: "Database connection refused" },
        ],
      }),
    ]);

    const errors = section(tree, "sentry");
    expect(errors.items.length).toBe(2);
    const titles = errors.items.map((i) => i.title).sort();
    expect(titles).toEqual([
      "Database connection refused",
      "TypeError: cannot read x of undefined",
    ]);
    // Each item has exactly one thread (its own scope-derived threadId).
    expect(errors.items.every((i) => i.routines.length === 1)).toBe(true);
  });

  test("falls back to project then scope label when no issue title", () => {
    const tree = buildTree([
      msg({
        id: "s3",
        event: "sentry:error",
        scope: "sentry-issue-555",
        keys: { key1Label: "level", key1: "warning", key2Label: "action", key2: "" },
        fields: [],
      }),
    ]);
    const errors = section(tree, "sentry");
    expect(errors.items.length).toBe(1);
    expect(errors.items[0]!.title).toBe("issue 555");
    expect(errors.items[0]!.key).toBe("sentry-issue-555");
  });
});

describe("buildTree — datadog", () => {
  test("keys each monitor by scope (not by priority) and titles by alert text", () => {
    const tree = buildTree([
      msg({
        id: "d1",
        event: "datadog:alert",
        scope: "dd-monitor-77",
        threadId: "oncall:hook:dd-monitor-77",
        jobName: "oncall",
        keys: { key1Label: "priority", key1: "P1", key2Label: "type", key2: "error" },
        fields: [
          { label: "monitor", value: "77" },
          { label: "priority", value: "P1" },
          { label: "title", value: "[P1] CPU on web-1 is high" },
        ],
      }),
      // Same priority P1 but a different monitor → separate item.
      msg({
        id: "d2",
        event: "datadog:alert",
        scope: "dd-monitor-88",
        threadId: "oncall:hook:dd-monitor-88",
        jobName: "oncall",
        keys: { key1Label: "priority", key1: "P1", key2Label: "type", key2: "error" },
        fields: [{ label: "title", value: "[P1] Disk full on db-2" }],
      }),
    ]);

    const alerts = section(tree, "datadog");
    expect(alerts.items.length).toBe(2);
    const titles = alerts.items.map((i) => i.title).sort();
    expect(titles).toEqual(["[P1] CPU on web-1 is high", "[P1] Disk full on db-2"]);
  });

  test("two alerts on the same monitor coalesce into one item with one thread", () => {
    const tree = buildTree([
      msg({
        id: "d3",
        event: "datadog:alert",
        scope: "dd-monitor-99",
        threadId: "oncall:hook:dd-monitor-99",
        jobName: "oncall",
        enqueuedAt: 1000,
        updatedAt: 1000,
        fields: [{ label: "title", value: "Latency alert" }],
      }),
      msg({
        id: "d4",
        event: "datadog:alert",
        scope: "dd-monitor-99",
        threadId: "oncall:hook:dd-monitor-99",
        jobName: "oncall",
        enqueuedAt: 2000,
        updatedAt: 2000,
        status: "running",
        fields: [{ label: "title", value: "Latency alert" }],
      }),
    ]);

    const alerts = section(tree, "datadog");
    expect(alerts.items.length).toBe(1);
    const item = alerts.items[0]!;
    expect(item.key).toBe("dd-monitor-99");
    expect(item.routines.length).toBe(1);
    // Newest row (running) wins for the live status shown on the thread.
    expect(item.routines[0]!.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// mergePolledPRs
// ---------------------------------------------------------------------------

function polledPR(over: Partial<PolledPR> & { repo: string; number: number }): PolledPR {
  return {
    title: "some PR",
    author: "alice",
    isDraft: false,
    updatedAt: "2024-01-01T12:00:00Z",
    labels: [],
    ...over,
  };
}

function queueItem(over: Partial<TreeItem> & { key: string }): TreeItem {
  return {
    title: over.key,
    routines: [],
    lastAt: 0,
    ...over,
  };
}

describe("mergePolledPRs", () => {
  test("PR already in queue is not duplicated", () => {
    const existing = queueItem({ key: "org/repo#42", repo: "org/repo", num: 42 });
    const polled = [polledPR({ repo: "org/repo", number: 42 })];
    const merged = mergePolledPRs([existing], polled);
    expect(merged.length).toBe(1);
    expect(merged[0]).toBe(existing); // exact same reference
  });

  test("PR not in queue is added as polled-only with correct lastAt", () => {
    const updatedAt = "2024-06-01T09:00:00Z";
    const polled = [polledPR({ repo: "org/repo", number: 7, title: "fix thing", updatedAt })];
    const merged = mergePolledPRs([], polled);
    expect(merged.length).toBe(1);
    const item = merged[0]!;
    expect(item.key).toBe("org/repo#7");
    expect(item.num).toBe(7);
    expect(item.repo).toBe("org/repo");
    expect(item.title).toBe("#7 — fix thing");
    expect(item.polledOnly).toBe(true);
    expect(item.routines).toEqual([]);
    expect(item.lastAt).toBe(Date.parse(updatedAt));
  });

  test("empty polled list returns original items unchanged", () => {
    const items = [queueItem({ key: "org/repo#1" })];
    const merged = mergePolledPRs(items, []);
    expect(merged).toBe(items); // same reference — no allocation
  });

  test("mix: queue items untouched, new polled-only items appended", () => {
    const existing = queueItem({ key: "org/repo#10", repo: "org/repo", num: 10 });
    const polled = [
      polledPR({ repo: "org/repo", number: 10 }), // already in queue
      polledPR({ repo: "org/repo", number: 99, title: "new PR" }), // not in queue
    ];
    const merged = mergePolledPRs([existing], polled);
    expect(merged.length).toBe(2);
    expect(merged[0]).toBe(existing);
    expect(merged[1]!.key).toBe("org/repo#99");
    expect(merged[1]!.polledOnly).toBe(true);
  });
});
