import { getReadCache } from "../../readCache";
import { enableCompression, storageTable } from "../../sqlite";
import type { ChatPart } from "../../../shared/transcriptParts";

export interface ThreadCursor {
  schemaVersion: 1;
  path: string; inode: number; size: number; mtime: number;
  byteOffset: number; lineIndex: number;
}
let initialized = false;
function database() {
  const db = getReadCache().db;
  if (!initialized) {
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_cursor (
      thread_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_parts (
        thread_id TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL,
        part_json TEXT NOT NULL, PRIMARY KEY(thread_id,id));`);
    db.exec(`CREATE INDEX IF NOT EXISTS conversation_parts_order ON ${storageTable(db, "conversation_parts")}(thread_id,sequence)`);
    enableCompression(db, "conversation_parts", "part_json");
    initialized = true;
  }
  return db;
}
export function threadCursor(threadId: string): ThreadCursor | undefined {
  const row = database().query<{ data: string }, [string]>("SELECT data FROM conversation_cursor WHERE thread_id=?").get(threadId);
  return row ? JSON.parse(row.data) as ThreadCursor : undefined;
}
export function storedParts(threadId: string, limit?: number, offset = 0): { parts: ChatPart[]; total: number } {
  const db = database();
  const total = db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM conversation_parts WHERE thread_id=?").get(threadId)!.n;
  const start = offset === -1 ? Math.max(0, total - (limit ?? total)) : offset;
  const rows = db.query<{ part_json: string }, [string, number, number]>(
    "SELECT part_json FROM conversation_parts WHERE thread_id=? ORDER BY sequence LIMIT ? OFFSET ?").all(threadId, limit ?? total, start);
  return { parts: rows.map(row => JSON.parse(row.part_json) as ChatPart), total };
}
export function saveThread(threadId: string, cursor: ThreadCursor, parts: ChatPart[], reset = false): void {
  const db = database();
  db.transaction(() => {
    if (reset) db.run("DELETE FROM conversation_parts WHERE thread_id=?", [threadId]);
    for (const part of parts) {
      const [line, block = "0"] = part.id.split(":");
      // The parser's ids are line:block, including user lines without a block.
      // Use numeric ordering rather than lexical ordering (10 follows 9).
      const sequence = Number(line) * 1_000_000 + (Number(block) || 0);
      db.run("INSERT OR REPLACE INTO conversation_parts(thread_id,id,sequence,part_json) VALUES(?,?,?,?)",
        [threadId, part.id, sequence, JSON.stringify(part)]);
    }
    db.run("INSERT OR REPLACE INTO conversation_cursor(thread_id,data) VALUES(?,?)", [threadId, JSON.stringify(cursor)]);
  })();
}
export function clearThread(threadId: string): void {
  const db = database();
  db.transaction(() => {
    db.run("DELETE FROM conversation_parts WHERE thread_id=?", [threadId]);
    db.run("DELETE FROM conversation_cursor WHERE thread_id=?", [threadId]);
  })();
}
