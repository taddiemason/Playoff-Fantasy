PRAGMA foreign_keys = ON;

ALTER TABLE leagues ADD COLUMN league_format TEXT NOT NULL DEFAULT 'redraft';
ALTER TABLE leagues ADD COLUMN phase TEXT NOT NULL DEFAULT 'active';

ALTER TABLE team_players ADD COLUMN is_taxi_squad INTEGER NOT NULL DEFAULT 0;

CREATE TABLE keeper_designations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id        INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_id          INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id        INTEGER NOT NULL,
  player_name      TEXT NOT NULL,
  player_meta_json TEXT NOT NULL DEFAULT '{}',
  cost_type        TEXT NOT NULL DEFAULT 'free',
  cost_value       INTEGER NOT NULL DEFAULT 0,
  season           TEXT NOT NULL,
  designated_at    TEXT NOT NULL,
  UNIQUE(league_id, team_id, player_id, season)
);

CREATE TABLE roster_snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id         INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_id           INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id         INTEGER NOT NULL,
  player_name       TEXT NOT NULL,
  player_meta_json  TEXT NOT NULL DEFAULT '{}',
  season            TEXT NOT NULL,
  was_keeper        INTEGER NOT NULL DEFAULT 0,
  keeper_cost_type  TEXT,
  keeper_cost_value INTEGER,
  snapshotted_at    TEXT NOT NULL
);
