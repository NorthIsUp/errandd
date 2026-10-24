import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadCache } from "../readCache";
import { openDatabase, sqliteZstdPath } from "../sqlite";
import { HookQueue } from "../hookQueue";

test("SQL read snapshots survive reopen, replacement and deletion", () => {
  const dir = mkdtempSync(join(tmpdir(), "errandd-sqlite-cache-"));
  const path = join(dir, "cache.db");
  let cache = new ReadCache(path);
  try {
    cache.set("plugins", "enabled", { enabled: true, version: "1" }, 123);
    cache.set("branches", "main", { exists: true });
    cache.close();
    cache = new ReadCache(path);
    expect(cache.get("plugins", "enabled")).toEqual({ value: { enabled: true, version: "1" }, updatedAt: 123 });
    cache.set("plugins", "enabled", { enabled: false, version: "2" }, 456);
    expect(cache.entries("plugins")).toEqual([["enabled", { value: { enabled: false, version: "2" }, updatedAt: 456 }]]);
    cache.delete("branches", "main");
    expect(cache.get("branches", "main")).toBeUndefined();
  } finally { cache.close(); rmSync(dir, { recursive: true, force: true }); }
});

test.skipIf(!sqliteZstdPath())("transparent compression reduces a real SQLite file and preserves queue lifecycle after reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "errandd-sqlite-zstd-"));
  const path = join(dir, "queue.db");
  let queue = new HookQueue(path);
  try {
    const body = "Webhook body: inspect the changes, run the tests, report the result.\n".repeat(100);
    for (let i = 0; i < 1000; i++) queue.enqueue({ id: `delivery-${i}`, threadId: "thread", jobName: "review", event: "push", scope: "main", payload: { body, index: i } });
    queue.close();
    const db = openDatabase(path);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const before = statSync(path).size;
    db.query("SELECT zstd_incremental_maintenance(NULL, 1)").get();
    db.exec("VACUUM; PRAGMA wal_checkpoint(TRUNCATE)");
    const after = statSync(path).size;
    expect(after).toBeLessThan(before * 0.5);
    expect(db.query("SELECT typeof(payload) AS type FROM _messages_zstd LIMIT 1").get()).toEqual({ type: "blob" });
    db.close();
    queue = new HookQueue(path);
    expect(queue.enqueue({ id: "delivery-0", threadId: "thread", jobName: "review", event: "push", scope: "main", payload: {} })).toBe(false);
    const claimed = queue.claimThread("thread");
    expect(claimed).toHaveLength(1000);
    expect(claimed[0].payload).toEqual({ body, index: 0 });
    expect(queue.requeueStuckRunning()).toBe(1000);
    queue.complete(["delivery-0"], "done");
    expect(queue.requeue(["delivery-0"])).toBe(1);
    queue.complete(["delivery-0"], "done");
    expect(queue.prune(0, Date.now() + 1)).toBe(1);
    console.log(`[sqlite-zstd] synthetic webhook database ${before} -> ${after} bytes`);
  } finally { queue.close(); rmSync(dir, { recursive: true, force: true }); }
});

test.skipIf(!sqliteZstdPath())("background maintenance makes progress without an offline compaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "errandd-zstd-worker-"));
  const cache = new ReadCache(join(dir, "cache.db"));
  const worker = new Worker(new URL("../sqliteMaintenance.ts", import.meta.url).href);
  try {
    for (let i = 0; i < 200; i++) cache.set("worker", String(i), { i, body: "compressed background payload\n".repeat(150) });
    worker.postMessage(cache.db.filename);
    const deadline = Date.now() + 8000;
    let pending = 200;
    while (pending > 0 && Date.now() < deadline) {
      await Bun.sleep(100);
      pending = cache.db.query<{ n: number }, []>(
        "SELECT count(*) AS n FROM _snapshots_zstd WHERE typeof(snapshot_json)='text'").get()!.n;
    }
    expect(pending).toBe(0);
    expect(cache.get<{ i: number }>("worker", "42")?.value.i).toBe(42);
  } finally {
    await worker.terminate();
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);
