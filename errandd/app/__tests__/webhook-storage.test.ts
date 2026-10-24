import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookQueue } from "../hookQueue";
import {
  __resetDeliveryStoreForTests,
  annotateSkip,
  attachDeliveryPayload,
  getDeliveryPayload,
  initDeliveryStore,
  recordDelivery,
  setDeliveryEvaluation,
} from "../hooks/deliveries";

function temporaryDb() {
  const dir = mkdtempSync(join(tmpdir(), "errandd-webhook-storage-"));
  return {
    file: join(dir, "store.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("queue metadata reads omit payload while workers and replay retain it", () => {
  const queue = new HookQueue(":memory:");
  try {
    const payload = { body: "large webhook body".repeat(10_000) };
    queue.enqueue({
      id: "a",
      threadId: "thread",
      jobName: "job",
      event: "push",
      scope: "main",
      payload,
    });
    expect(queue.list({ includePayload: false })[0].payload).toBeNull();
    expect(queue.listLatestPerThread(500, false)[0].payload).toBeNull();
    expect(queue.listLatestPerThread()[0].payload).toEqual(payload);
    const [claimed] = queue.claimThread("thread", 1234 + Date.now());
    expect(claimed.status).toBe("running");
    expect(claimed.payload).toEqual(payload);
    queue.complete(["a"], "done");
    queue.requeue(["a"]);
    expect(queue.claimThread("thread")[0].payload).toEqual(payload);
  } finally {
    queue.close();
  }
});

test("queue time-ordered inspection uses indexes without full-history sorts", () => {
  const temporary = temporaryDb();
  const queue = new HookQueue(temporary.file);
  try {
    const db = new Database(temporary.file, { readonly: true });
    try {
      for (const sql of [
        "SELECT * FROM messages ORDER BY enqueued_at DESC LIMIT 500",
        "SELECT * FROM messages WHERE thread_id = 'thread' ORDER BY enqueued_at DESC LIMIT 50",
      ]) {
        const plan = db
          .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`)
          .all()
          .map((row) => row.detail)
          .join("\n");
        expect(plan).toContain("INDEX");
        expect(plan).not.toContain("TEMP B-TREE");
      }
    } finally {
      db.close();
    }
  } finally {
    queue.close();
    temporary.cleanup();
  }
});

test("delivery annotations preserve payload without serializing it repeatedly", () => {
  const temporary = temporaryDb();
  __resetDeliveryStoreForTests();
  try {
    initDeliveryStore(temporary.file);
    let serialized = 0;
    const payload = {
      toJSON() {
        serialized++;
        return { body: "large webhook body" };
      },
    };
    recordDelivery({
      id: "d",
      event: "push",
      receivedAt: Date.now(),
      summary: "push",
      status: "ok",
      matched: [],
      payloadSnippet: "",
    });
    attachDeliveryPayload("d", payload);
    expect(serialized).toBe(1);
    setDeliveryEvaluation("d", { source: "github", pk: "main" });
    annotateSkip("d", "job", "ignored");
    expect(serialized).toBe(1);
    __resetDeliveryStoreForTests();
    initDeliveryStore(temporary.file);
    expect(getDeliveryPayload("d")).toEqual({
      event: "push",
      payload: { body: "large webhook body" },
    });
  } finally {
    __resetDeliveryStoreForTests();
    temporary.cleanup();
  }
});

test("durable delivery retention stays bounded while the process keeps running", () => {
  const temporary = temporaryDb();
  __resetDeliveryStoreForTests();
  try {
    initDeliveryStore(temporary.file);
    for (let i = 0; i < 640; i++) {
      recordDelivery({
        id: `d-${i}`,
        event: "push",
        receivedAt: i,
        summary: "push",
        status: "ok",
        matched: [],
        payloadSnippet: "",
        payload: { i },
      });
    }
    const db = new Database(temporary.file, { readonly: true });
    try {
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM deliveries").get()?.n).toBe(
        500,
      );
      expect(
        db
          .query<{ id: string }, []>("SELECT id FROM deliveries ORDER BY received_at ASC LIMIT 1")
          .get()?.id,
      ).toBe("d-140");
    } finally {
      db.close();
    }
    __resetDeliveryStoreForTests();
    initDeliveryStore(temporary.file);
    expect(getDeliveryPayload("d-639")).toEqual({ event: "push", payload: { i: 639 } });
  } finally {
    __resetDeliveryStoreForTests();
    temporary.cleanup();
  }
});

test("delivery dedup expires exactly even between amortized cleanup scans", () => {
  __resetDeliveryStoreForTests();
  const clock = spyOn(Date, "now");
  const delivery = (id: string) => ({
    id,
    event: "push",
    receivedAt: Date.now(),
    summary: "",
    status: "ok" as const,
    matched: [],
    payloadSnippet: "",
  });
  try {
    clock.mockReturnValue(0);
    expect(recordDelivery(delivery("a"))).toBe(true);
    clock.mockReturnValue(24 * 60 * 60 * 1000 - 1);
    expect(recordDelivery(delivery("b"))).toBe(true); // scan keeps a just before expiry
    clock.mockReturnValue(24 * 60 * 60 * 1000 + 1);
    expect(recordDelivery(delivery("a"))).toBe(true); // scan throttled, lookup still expires
    expect(recordDelivery(delivery("a"))).toBe(false);
  } finally {
    clock.mockRestore();
    __resetDeliveryStoreForTests();
  }
});
