PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS chat_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id   INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  username    TEXT NOT NULL,
  body        TEXT NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0,
  pinned_at   TEXT,
  deleted_at  TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_league ON chat_messages(league_id, created_at);

CREATE TABLE IF NOT EXISTS chat_reactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL,
  emoji       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(message_id, user_id, emoji)
);
