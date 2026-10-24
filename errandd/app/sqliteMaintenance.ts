// Compression runs outside the HTTP/event-loop thread. Yield between bounded
// batches; once caught up, scan for new work only once per minute.
import type { Database } from "bun:sqlite";
import { openDatabase } from "./sqlite";
process.env.RUST_LOG ??= "warn";
const stores = new Map<string, { db: Database; nextAt: number }>();
self.onmessage = (event: MessageEvent<string>) => {
  if (!stores.has(event.data)) {
    try { stores.set(event.data, { db: openDatabase(event.data), nextAt: 0 }); }
    catch (error) { console.warn("[sqlite] Compression open failed:", error); }
  }
};
setInterval(() => {
  for (const store of stores.values()) {
    if (Date.now() < store.nextAt) continue;
    try {
      const result = store.db.query<{ pending: number }, []>(
        "SELECT zstd_incremental_maintenance(1, 0.2) AS pending").get();
      store.nextAt = Date.now() + (result?.pending ? 1000 : 60_000);
    } catch (error) {
      store.nextAt = Date.now() + 60_000;
      console.warn("[sqlite] Compression maintenance:", error);
    }
  }
}, 100);
