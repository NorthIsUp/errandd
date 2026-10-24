-- Frozen schema from release 1.0.348 (7d8d48db), before sqlite-zstd.
-- Do not generate this fixture with the current store constructors.
CREATE TABLE IF NOT EXISTS sentry_seen (
      issue_id      TEXT PRIMARY KEY,
      first_seen_at INTEGER NOT NULL
    );
