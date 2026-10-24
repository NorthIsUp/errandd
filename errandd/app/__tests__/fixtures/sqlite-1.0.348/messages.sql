-- Frozen schema from release 1.0.348 (7d8d48db), before sqlite-zstd.
-- Do not generate this fixture with the current store constructors.
CREATE TABLE IF NOT EXISTS messages (
        id          TEXT PRIMARY KEY,
        thread_id   TEXT NOT NULL,
        job_name    TEXT NOT NULL,
        event       TEXT NOT NULL,
        scope       TEXT NOT NULL,
        payload     TEXT NOT NULL,
        enqueued_at INTEGER NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        attempts    INTEGER NOT NULL DEFAULT 0,
        not_before  INTEGER NOT NULL DEFAULT 0,
        pr_repo     TEXT,
        pr_number   INTEGER,
        keys        TEXT,
        fields      TEXT,
        outcome     TEXT,
        error       TEXT,
        updated_at  INTEGER NOT NULL
      );
ALTER TABLE messages ADD COLUMN trace_id TEXT;
ALTER TABLE messages ADD COLUMN rate_limit_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_messages_thread_status ON messages(thread_id, status, not_before);
CREATE INDEX IF NOT EXISTS idx_messages_thread_updated ON messages(thread_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_status_notbefore ON messages(status, not_before);
CREATE INDEX IF NOT EXISTS idx_messages_status_enqueued ON messages(status, enqueued_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_enqueued ON messages(enqueued_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread_enqueued ON messages(thread_id, enqueued_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_updated ON messages(updated_at DESC);
