-- Frozen schema from release 1.0.348 (7d8d48db), before sqlite-zstd.
-- Do not generate this fixture with the current store constructors.
CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, event TEXT NOT NULL, received_at INTEGER NOT NULL,
      summary TEXT NOT NULL, status TEXT NOT NULL, source TEXT, pk TEXT,
      keys TEXT, fields TEXT, routines TEXT, payload_snippet TEXT NOT NULL,
      payload TEXT, updated_at INTEGER NOT NULL
    );
CREATE INDEX IF NOT EXISTS idx_deliveries_received ON deliveries(received_at DESC);
