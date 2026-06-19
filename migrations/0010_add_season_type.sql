-- Add season type to leagues ('playoffs' or 'regular')
ALTER TABLE leagues ADD COLUMN season_type TEXT NOT NULL DEFAULT 'playoffs';

-- Recreate player_stats_snapshots with game_type in the primary key so that
-- regular-season (gameTypeId=2) and playoff (gameTypeId=3) stats can coexist
-- for the same player+season without overwriting each other.
CREATE TABLE player_stats_snapshots_v2 (
  player_id INTEGER NOT NULL,
  season TEXT NOT NULL,
  game_type INTEGER NOT NULL DEFAULT 3,
  stats_json TEXT NOT NULL,
  fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id, season, game_type)
);

INSERT INTO player_stats_snapshots_v2 (player_id, season, game_type, stats_json, fetched_at)
SELECT player_id, season, 3, stats_json, fetched_at FROM player_stats_snapshots;

DROP TABLE player_stats_snapshots;

ALTER TABLE player_stats_snapshots_v2 RENAME TO player_stats_snapshots;

DROP INDEX IF EXISTS idx_player_stats_snapshots_season_fetched_at;
CREATE INDEX IF NOT EXISTS idx_player_stats_snapshots_season_fetched_at
  ON player_stats_snapshots (season, fetched_at);
