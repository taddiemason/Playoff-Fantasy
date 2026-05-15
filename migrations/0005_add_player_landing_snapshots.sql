CREATE TABLE IF NOT EXISTS player_landing_snapshots (
  player_id INTEGER PRIMARY KEY,
  landing_json TEXT NOT NULL,
  headshot_url TEXT DEFAULT '',
  fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_player_landing_snapshots_fetched_at
  ON player_landing_snapshots (fetched_at);
