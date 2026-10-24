-- Frozen schema from release 1.0.348 (7d8d48db), before sqlite-zstd.
-- Do not generate this fixture with the current store constructors.
CREATE TABLE IF NOT EXISTS pr_state (
      key        TEXT PRIMARY KEY,
      state      TEXT NOT NULL,
      mergeable  INTEGER,
      updated_at INTEGER NOT NULL
    );
