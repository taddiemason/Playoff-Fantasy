CREATE TABLE IF NOT EXISTS player_stats_snapshots (
  player_id INTEGER NOT NULL,
  season TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id, season)
);

CREATE INDEX IF NOT EXISTS idx_player_stats_snapshots_season_fetched_at
  ON player_stats_snapshots (season, fetched_at);

CREATE TABLE IF NOT EXISTS team_points_snapshots (
  team_id INTEGER NOT NULL,
  season TEXT NOT NULL,
  total_points REAL NOT NULL,
  computed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (team_id, season),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_team_points_snapshots_season_computed_at
  ON team_points_snapshots (season, computed_at);
