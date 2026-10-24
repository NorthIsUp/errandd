/** Deployment gate: seed frozen pre-upgrade schemas, never the new constructors. */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookQueue } from "../hookQueue";
import { InteractiveQueue } from "../messaging/interactiveQueue";
import { enableCompression, openDatabase, sqliteZstdPath } from "../sqlite";
import { __resetDeliveryStoreForTests, annotateSkip, getDeliveryPayload, initDeliveryStore } from "../hooks/deliveries";
import { __resetPrStatesForTest, getPrState, initPrStateStore } from "../pr-state";
import { __resetSentrySeenStoreForTests, initSentrySeenStore, markIssueSeen } from "../hooks/sentrySeen";

if (process.env.ERRANDD_REQUIRE_SQLITE_ZSTD === "1" && !sqliteZstdPath()) {
  throw new Error("Upgrade gate requires the native sqlite-zstd extension; run bun run setup:sqlite-zstd first.");
}
const fixture = (table: string) => readFileSync(join(import.meta.dir, "fixtures/sqlite-1.0.348", `${table}.sql`), "utf8");
const now = Date.now();
const payload = JSON.stringify({ text: "Raw JSON / Unicode 🦞 / CRLF\r\n", nested: { null: null, bool: false, empty: "" }, body: "Webhook payload and command output\n".repeat(150) });
function temporary() {
  const dir = mkdtempSync(join(tmpdir(), "errandd-upgrade-"));
  return { path: join(dir, "store.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function legacy(path: string, table: string, schema = fixture(table)) {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  db.exec(schema);
  return db;
}
function rows(db: Database, table: string) {
  return db.query(`SELECT * FROM ${table} ORDER BY 1`).all();
}
function verify(db: Database, table: string, expected: unknown[]) {
  expect(rows(db, table)).toEqual(expected);
  expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
}
function compressAndReopen(path: string, table: string, expected: unknown[]) {
  const db = openDatabase(path);
  try {
    db.query("SELECT zstd_incremental_maintenance(NULL,1)").get();
    db.exec("VACUUM; PRAGMA wal_checkpoint(TRUNCATE)");
    verify(db, table, expected);
  } finally { db.close(); }
}

// A release/Docker build sets REQUIRE above: these tests cannot silently skip.
describe.skipIf(!sqliteZstdPath())("upgrade from production release 1.0.348", () => {
  test("hook queue preserves WAL-resident rows, all metadata, pending work and dedup across compression and repeated boots", () => {
    const temp = temporary();
    const old = legacy(temp.path, "messages");
    let queue: HookQueue | undefined;
    try {
      old.transaction(() => {
        for (let i = 0; i < 160; i++) old.run(`INSERT INTO messages
          (id,thread_id,job_name,event,scope,payload,enqueued_at,status,attempts,not_before,pr_repo,pr_number,keys,fields,outcome,error,updated_at,trace_id,rate_limit_attempts)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [`delivery-${i}`, "review:hook:pr-42", "review", "issue_comment", "pr-42", payload, now + i,
            ["pending", "running", "done", "failed"][i % 4], i % 7, i === 0 ? now + 60_000 : 0,
            "org/repo", 42, '{"action":"edited"}', '[{"name":"author","value":"alice"}]', i % 4 === 2 ? "pass" : null,
            i % 4 === 3 ? "retry me" : null, now, `trace-${i}`, i % 3]);
      })();
      const before = rows(old, "messages");
      // The old connection stays open: committed rows still live in WAL.
      expect(statSync(`${temp.path}-wal`).size).toBeGreaterThan(0);
      queue = new HookQueue(temp.path);
      old.close();
      const upgraded = openDatabase(temp.path);
      verify(upgraded, "messages", before);
      upgraded.close();
      queue.close();
      compressAndReopen(temp.path, "messages", before);
      for (let boot = 0; boot < 2; boot++) {
        queue = new HookQueue(temp.path);
        const db = openDatabase(temp.path);
        verify(db, "messages", before);
        expect(db.query("SELECT count(*) AS n FROM _messages_zstd WHERE typeof(payload)='blob'").get()).toEqual({ n: 160 });
        db.close();
        queue.close();
      }
      queue = new HookQueue(temp.path);
      expect(queue.enqueue({ id: "delivery-0", threadId: "other", jobName: "review", event: "push", scope: "main", payload: {} })).toBe(false);
      expect(queue.requeueStuckRunning()).toBe(40);
      const claimed = queue.claimThread("review:hook:pr-42", now + 10_000);
      expect(claimed).toHaveLength(79);
      expect(claimed.some(row => row.id === "delivery-0")).toBe(false);
      expect(claimed.every(row => JSON.stringify(row.payload) === payload)).toBe(true);
      queue.complete(claimed.map(row => row.id), "done");
      expect(queue.requeue(["delivery-3"])).toBe(1);
      expect(queue.enqueue({ id: "new-after-upgrade", threadId: "new-thread", jobName: "review", event: "push", scope: "main", payload: { new: true } })).toBe(true);
      expect(queue.claimThread("new-thread")[0].payload).toEqual({ new: true });
    } finally { old.close(); queue?.close(); temp.cleanup(); }
  });

  test("older hook schemas gain missing columns without losing existing rows", () => {
    const temp = temporary();
    const schema = fixture("messages").replace(/ALTER TABLE messages ADD COLUMN[^;]+;/g, "");
    const old = legacy(temp.path, "messages", schema);
    let queue: HookQueue | undefined;
    try {
      old.run("INSERT INTO messages(id,thread_id,job_name,event,scope,payload,enqueued_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        ["historical", "thread", "review", "push", "main", payload, now, now]);
      const before = rows(old, "messages")[0] as Record<string, unknown>;
      old.close();
      queue = new HookQueue(temp.path);
      const db = openDatabase(temp.path);
      expect(rows(db, "messages")).toEqual([{ ...before, trace_id: null, rate_limit_attempts: 0 }]);
      db.close();
      expect(queue.claimThread("thread")[0].payload).toEqual(JSON.parse(payload));
    } finally { old.close(); queue?.close(); temp.cleanup(); }
  });

  test("interactive queue preserves prompts, destinations, retry state and crash recovery", () => {
    const temp = temporary();
    const old = legacy(temp.path, "interactive");
    let queue: InteractiveQueue | undefined;
    try {
      old.transaction(() => {
        for (let i = 0; i < 160; i++) old.run(`INSERT INTO interactive
          (id,platform,chat_id,thread_ts,user_id,session_key,agent_name,text,enqueued_at,status,attempts,not_before,error,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [`interactive-${i}`, "slack", "channel", "123.456", "user", "session", "review", payload,
          now + i, ["pending", "running", "done", "failed"][i % 4], i % 5, i === 0 ? now + 60_000 : 0, i % 4 === 3 ? "retry" : null, now]);
      })();
      const before = rows(old, "interactive");
      queue = new InteractiveQueue(temp.path);
      old.close(); queue.close();
      compressAndReopen(temp.path, "interactive", before);
      queue = new InteractiveQueue(temp.path);
      const db = openDatabase(temp.path); verify(db, "interactive", before); db.close();
      expect(queue.requeueStuckRunning()).toBe(40);
      const claimed = queue.claimReady(now + 10_000);
      expect(claimed).toHaveLength(79);
      expect(claimed.every(row => row.text === payload && row.chatId === "channel" && row.threadTs === "123.456")).toBe(true);
    } finally { old.close(); queue?.close(); temp.cleanup(); }
  });

  test("delivery migration preserves payload bytes and annotations across restart and later metadata updates", () => {
    const temp = temporary();
    const old = legacy(temp.path, "deliveries");
    __resetDeliveryStoreForTests();
    try {
      old.transaction(() => {
        for (let i = 0; i < 160; i++) old.run(`INSERT INTO deliveries
          (id,event,received_at,summary,status,source,pk,keys,fields,routines,payload_snippet,payload,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [`hook-${i}`, "issue_comment", now + i, "comment edited", "ok", "github", "pr-42",
          '{"action":"edited"}', null, null, `snippet ${i}`, i === 0 ? null : payload, now]);
      })();
      const before = rows(old, "deliveries");
      initDeliveryStore(temp.path); old.close(); __resetDeliveryStoreForTests();
      compressAndReopen(temp.path, "deliveries", before);
      for (let boot = 0; boot < 2; boot++) {
        initDeliveryStore(temp.path);
        const db = openDatabase(temp.path); verify(db, "deliveries", before); db.close();
        expect(getDeliveryPayload("hook-42")).toEqual({ event: "issue_comment", payload: JSON.parse(payload) });
        __resetDeliveryStoreForTests();
      }
      initDeliveryStore(temp.path);
      annotateSkip("hook-42", "review", "ignored after upgrade");
      __resetDeliveryStoreForTests(); initDeliveryStore(temp.path);
      expect(getDeliveryPayload("hook-42")).toEqual({ event: "issue_comment", payload: JSON.parse(payload) });
    } finally { old.close(); __resetDeliveryStoreForTests(); temp.cleanup(); }
  });

  test("uncompressed PR state and Sentry dedup ledgers survive the new connection setup", () => {
    const temp = temporary();
    const old = legacy(temp.path, "pr_state");
    old.exec(fixture("sentry_seen"));
    old.run("INSERT INTO pr_state VALUES(?,?,?,?)", ["org/repo#42", "merged", 1, now]);
    old.run("INSERT INTO sentry_seen VALUES(?,?)", ["seen-before-upgrade", now]);
    const prs = rows(old, "pr_state"); const seen = rows(old, "sentry_seen"); old.close();
    try {
      for (let boot = 0; boot < 2; boot++) {
        __resetPrStatesForTest(); __resetSentrySeenStoreForTests();
        initPrStateStore(temp.path); initSentrySeenStore(temp.path);
        expect(getPrState("org/repo#42")).toEqual({ state: "merged", mergeable: true });
        expect(markIssueSeen("seen-before-upgrade")).toEqual({ firstSeen: false });
        const db = openDatabase(temp.path); verify(db, "pr_state", prs); verify(db, "sentry_seen", seen); db.close();
      }
    } finally { __resetPrStatesForTest(); __resetSentrySeenStoreForTests(); temp.cleanup(); }
  });

  test("failed compression migration rolls back DDL and data, then retries safely", () => {
    const temp = temporary();
    const db = legacy(temp.path, "messages");
    try {
      db.run("INSERT INTO messages(id,thread_id,job_name,event,scope,payload,enqueued_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        ["survivor", "thread", "review", "push", "main", payload, now, now]);
      const before = rows(db, "messages");
      db.close();
      const migrate = openDatabase(temp.path);
      try {
        migrate.exec("CREATE TABLE canary(id TEXT PRIMARY KEY); CREATE INDEX _payload_dict_idx ON canary(id)");
        expect(() => enableCompression(migrate, "messages", "payload")).toThrow();
        verify(migrate, "messages", before);
        expect(migrate.query("SELECT type FROM sqlite_master WHERE name='messages'").get()).toEqual({ type: "table" });
        migrate.exec("DROP INDEX _payload_dict_idx");
        enableCompression(migrate, "messages", "payload");
        verify(migrate, "messages", before);
      } finally { migrate.close(); }
    } finally { db.close(); temp.cleanup(); }
  });

  test("out-of-space during migration preserves old rows and allows a later retry", () => {
    const temp = temporary();
    const old = legacy(temp.path, "messages");
    old.run("INSERT INTO messages(id,thread_id,job_name,event,scope,payload,enqueued_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      ["disk-full-survivor", "thread", "review", "push", "main", payload, now, now]);
    const before = rows(old, "messages"); old.close();
    const db = openDatabase(temp.path);
    try {
      const pages = db.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count;
      // Force SQLITE_FULL without filling the host's real disk.
      db.exec(`PRAGMA max_page_count=${pages}`);
      expect(() => enableCompression(db, "messages", "payload")).toThrow(/full/i);
      verify(db, "messages", before);
      db.exec("PRAGMA max_page_count=1073741823");
      enableCompression(db, "messages", "payload");
      verify(db, "messages", before);
    } finally { db.close(); temp.cleanup(); }
  });
});
