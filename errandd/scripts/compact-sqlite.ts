/** Run while Errandd is stopped. VACUUM needs temporary free disk space. */
import { openDatabase } from "../app/sqlite";
const paths = process.argv.slice(2);
if (!paths.length) throw new Error("Usage: bun run compact:sqlite DATABASE [DATABASE ...] (stop Errandd first)");
for (const path of paths) {
  if (!(await Bun.file(path).exists())) throw new Error(`No database: ${path}`);
  const before = Bun.file(path).size;
  const db = openDatabase(path);
  try {
    if (db.query("SELECT 1 FROM sqlite_master WHERE name='_zstd_configs'").get()) {
      db.query("SELECT zstd_incremental_maintenance(NULL, 1)").get();
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA auto_vacuum=FULL; VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
    console.log(JSON.stringify({ path, before, after: Bun.file(path).size }));
  } finally { db.close(); }
}
