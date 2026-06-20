-- migrations/0016_nhl_players.sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS nhl_players (
  player_id     INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  position_code TEXT NOT NULL DEFAULT '',
  nhl_team      TEXT NOT NULL DEFAULT '',
  sweater_num   INTEGER,
  headshot_url  TEXT NOT NULL DEFAULT '',
  season        TEXT NOT NULL,
  synced_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nhl_players_name ON nhl_players(name);
CREATE INDEX IF NOT EXISTS idx_nhl_players_season ON nhl_players(season);
