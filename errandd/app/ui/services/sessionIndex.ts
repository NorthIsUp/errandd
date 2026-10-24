import { getReadCache } from "../../readCache";
import { enableCompression, storageTable } from "../../sqlite";
import type { SessionInfo } from "./sessions";

let initialized = false;
function database() {
  const db = getReadCache().db;
  if (!initialized) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_index (
      id TEXT PRIMARY KEY, last_used_at TEXT NOT NULL, closed INTEGER NOT NULL,
      hash TEXT NOT NULL, session_json TEXT NOT NULL);`);
    const table = storageTable(db, "session_index");
    db.exec(`CREATE INDEX IF NOT EXISTS session_index_recent ON ${table}(last_used_at DESC);
      CREATE INDEX IF NOT EXISTS session_index_open ON ${table}(closed,last_used_at DESC);`);
    enableCompression(db, "session_index", "session_json");
    initialized = true;
  }
  return db;
}
export function storeSessionIndex(sessions: SessionInfo[]): void {
  const db = database();
  const existing = new Map(db.query<{ id: string; hash: string }, []>("SELECT id,hash FROM session_index").all().map(row => [row.id, row.hash]));
  db.transaction(() => {
    for (const session of sessions) {
      const json = JSON.stringify(session);
      const hash = Bun.hash(json).toString();
      if (existing.get(session.id) !== hash) db.run(
        "INSERT OR REPLACE INTO session_index(id,last_used_at,closed,hash,session_json) VALUES(?,?,?,?,?)",
        [session.id, session.lastUsedAt, Number(session.closed), hash, json]);
      existing.delete(session.id);
    }
    for (const id of existing.keys()) db.run("DELETE FROM session_index WHERE id=?", [id]);
    getReadCache().set("sessions", "indexed", { count: sessions.length });
  })();
}
export function indexedSessions(includeClosed = false, limit?: number, offset = 0): SessionInfo[] {
  return database().query<{ session_json: string }, [number, number]>(
    `SELECT session_json FROM session_index ${includeClosed ? "" : "WHERE closed=0"}
     ORDER BY last_used_at DESC LIMIT ? OFFSET ?`).all(limit ?? -1, offset)
    .map(row => JSON.parse(row.session_json) as SessionInfo);
}
export function updateIndexedSession(id: string, mutate: (session: SessionInfo) => SessionInfo): void {
  const db = database();
  const row = db.query<{ session_json: string }, [string]>("SELECT session_json FROM session_index WHERE id=?").get(id);
  if (!row) return;
  const session = mutate(JSON.parse(row.session_json) as SessionInfo);
  const json = JSON.stringify(session);
  db.run("UPDATE session_index SET closed=?,hash=?,session_json=? WHERE id=?",
    [Number(session.closed), Bun.hash(json).toString(), json, id]);
}
