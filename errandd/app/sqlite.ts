import { Database, type SQLQueryBindings } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";

// Apple's SQLite disables extension loading. Configure Bun before the first
// connection; Linux uses Bun's SQLite. Never switch a running connection.
// Bun shares the selected SQLite library with workers; it can only be selected once.
if (process.platform === "darwin" && isMainThread) {
  const library = process.env.ERRANDD_SQLITE_LIBRARY ??
    ["/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", "/usr/local/opt/sqlite/lib/libsqlite3.dylib"]
      .find(existsSync);
  if (library) Database.setCustomSQLite(library);
}

export function sqliteZstdPath(): string | undefined {
  const suffix = process.platform === "darwin" ? "dylib" : "so";
  return process.env.ERRANDD_SQLITE_ZSTD_EXTENSION ??
    [join(import.meta.dir, "../.native", `libsqlite_zstd.${suffix}`), "/usr/local/lib/libsqlite_zstd.so"]
      .find(existsSync);
}

let warned = false;
export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA busy_timeout=5000;");
  if (!db.query("SELECT 1 FROM sqlite_master LIMIT 1").get()) db.exec("PRAGMA auto_vacuum=FULL;");
  db.exec("PRAGMA journal_mode=WAL;");
  const extension = sqliteZstdPath();
  if (extension) {
    try {
      // The native library otherwise logs every maintenance scan at INFO.
      process.env.RUST_LOG ??= "warn";
      db.loadExtension(extension);
    } catch (error) {
      db.close();
      throw new Error(`Cannot load sqlite-zstd (${extension})`, { cause: error });
    }
  } else {
    // An already compressed database MUST NOT silently fall back: its views
    // require decompression functions even for ordinary SELECTs.
    if (db.query("SELECT 1 FROM sqlite_master WHERE name='_zstd_configs'").get()) {
      db.close();
      throw new Error("This database requires sqlite-zstd. Run bun run setup:sqlite-zstd.");
    }
    if (path !== ":memory:" && !warned) {
      warned = true;
      console.warn("[sqlite] Compression unavailable; run bun run setup:sqlite-zstd to enable it.");
    }
  }
  return db;
}

/** Only schema migrations need to know about the extension's backing table. */
export function storageTable(db: Database, table: string): string {
  return db.query("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'").get(`_${table}_zstd`)
    ? `_${table}_zstd` : table;
}

let maintenance: Worker | undefined;
export function enableCompression(db: Database, table: string, column: string): void {
  if (!sqliteZstdPath()) return;
  const configured = db.query("SELECT 1 FROM sqlite_master WHERE name='_zstd_configs'").get();
  if (!configured || !db.query("SELECT 1 FROM _zstd_configs WHERE json_extract(config,'$.table')=? AND json_extract(config,'$.column')=?").get(table, column)) {
    db.query("SELECT zstd_enable_transparent(?)").get(JSON.stringify({
      table, column, compression_level: 3, dict_chooser: "'shared'",
      incremental_compression_step_bytes: 262144,
    }));
  }
  const file = db.query<{ file: string }, []>("PRAGMA database_list").get()?.file;
  if (file && process.env.NODE_ENV !== "test") {
    maintenance ??= new Worker(new URL("./sqliteMaintenance.ts", import.meta.url).href, { ...{ ref: false } });
    maintenance.postMessage(file);
  }
}

/** INSTEAD OF triggers make sqlite3_changes() report zero. Count matching
 * rows under the same write lock so callers retain normal table semantics. */
export function countedMutation(db: Database, table: string, where: string,
  bindings: SQLQueryBindings[], mutate: () => unknown): number {
  return db.transaction(() => {
    const count = db.query<{ n: number }, SQLQueryBindings[]>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...bindings)!.n;
    mutate();
    return count;
  }).immediate();
}
