/** Persisted UI read projections. External CLIs/files remain the source of
 * truth; only background refreshes touch them after a snapshot is available. */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { enableCompression, openDatabase } from "./sqlite";

export class ReadCache {
  readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = openDatabase(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS snapshots (
      namespace TEXT NOT NULL, key TEXT NOT NULL, snapshot_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY(namespace,key));
      CREATE TABLE IF NOT EXISTS plugin_state (
        id TEXT NOT NULL, scope TEXT NOT NULL, project_path TEXT NOT NULL,
        enabled INTEGER NOT NULL, version TEXT NOT NULL, last_updated TEXT,
        PRIMARY KEY(id,scope,project_path));
      CREATE TABLE IF NOT EXISTS plugin_operations (
        id INTEGER PRIMARY KEY, operation TEXT NOT NULL, target TEXT,
        ok INTEGER NOT NULL, finished_at INTEGER NOT NULL, error TEXT);
      CREATE INDEX IF NOT EXISTS plugin_state_enabled ON plugin_state(enabled);`);
    enableCompression(this.db, "snapshots", "snapshot_json");
  }
  get<T>(namespace: string, key: string): { value: T; updatedAt: number } | undefined {
    const row = this.db.query<{ snapshot_json: string; updated_at: number }, [string, string]>(
      "SELECT snapshot_json, updated_at FROM snapshots WHERE namespace=? AND key=?").get(namespace, key);
    return row ? { value: JSON.parse(row.snapshot_json) as T, updatedAt: row.updated_at } : undefined;
  }
  set(namespace: string, key: string, value: unknown, updatedAt = Date.now()): void {
    // UPSERT is unsupported on sqlite-zstd views. OR REPLACE preserves the
    // same key and works on both plain tables and transparent views.
    this.db.run("INSERT OR REPLACE INTO snapshots(namespace,key,snapshot_json,updated_at) VALUES(?,?,?,?)",
      [namespace, key, JSON.stringify(value), updatedAt]);
  }
  entries<T>(namespace: string): [string, { value: T; updatedAt: number }][] {
    return this.db.query<{ key: string; snapshot_json: string; updated_at: number }, [string]>(
      "SELECT key,snapshot_json,updated_at FROM snapshots WHERE namespace=?").all(namespace)
      .map(row => [row.key, { value: JSON.parse(row.snapshot_json) as T, updatedAt: row.updated_at }]);
  }
  delete(namespace: string, key: string): void {
    this.db.run("DELETE FROM snapshots WHERE namespace=? AND key=?", [namespace, key]);
  }
  close(): void { this.db.close(); }
}

let cache: ReadCache | undefined;
export function getReadCache(): ReadCache {
  return cache ??= new ReadCache(process.env.ERRANDD_READ_CACHE_PATH ?? (process.env.NODE_ENV === "test" ? ":memory:" :
    join(process.cwd(), ".claude/errandd/read-cache.db")));
}

const refreshing = new Map<string, Promise<unknown>>();
/** Mutations refresh after any older discovery request, so a late CLI result
 * cannot overwrite the enabled state/version the user just changed. */
export function refreshCachedRead<T>(namespace: string, key: string,
  refresh: () => Promise<T>): Promise<T> {
  const refreshKey = `${namespace}:${key}`;
  const previous = refreshing.get(refreshKey);
  const pending = Promise.resolve(previous).catch(() => {}).then(refresh).then(value => {
    getReadCache().set(namespace, key, value);
    return value;
  }).finally(() => {
    if (refreshing.get(refreshKey) === pending) refreshing.delete(refreshKey);
  });
  refreshing.set(refreshKey, pending);
  return pending;
}
/** Serve a durable snapshot immediately; a cold cache waits only once. */
export async function cachedRead<T>(namespace: string, key: string, ttl: number,
  refresh: () => Promise<T>): Promise<T> {
  const store = getReadCache();
  const saved = store.get<T>(namespace, key);
  const refreshKey = `${namespace}:${key}`;
  const update = (): Promise<T> => {
    const existing = refreshing.get(refreshKey);
    if (existing) return existing as Promise<T>;
    const pending = refresh().then(value => {
      store.set(namespace, key, value);
      return value;
    }).finally(() => {
      if (refreshing.get(refreshKey) === pending) refreshing.delete(refreshKey);
    });
    refreshing.set(refreshKey, pending);
    return pending;
  };
  if (!saved) return update();
  if (Date.now() - saved.updatedAt > ttl) {
    // Even an async refresh may run synchronous git/filesystem work before its
    // first await. Let the cached HTTP response leave before starting it.
    setTimeout(() => void update().catch(error => console.warn(`[cache] ${namespace} refresh failed:`, error)), 0);
  }
  return saved.value;
}
