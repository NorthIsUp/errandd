-- Frozen schema from release 1.0.348 (7d8d48db), before sqlite-zstd.
-- Do not generate this fixture with the current store constructors.
CREATE TABLE IF NOT EXISTS interactive (
        id          TEXT PRIMARY KEY,
        platform    TEXT NOT NULL,
        chat_id     TEXT NOT NULL,
        thread_ts   TEXT,
        user_id     TEXT,
        session_key TEXT,
        agent_name  TEXT,
        text        TEXT NOT NULL,
        enqueued_at INTEGER NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        attempts    INTEGER NOT NULL DEFAULT 0,
        not_before  INTEGER NOT NULL DEFAULT 0,
        error       TEXT,
        updated_at  INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS idx_interactive_status ON interactive(status, not_before, enqueued_at);
