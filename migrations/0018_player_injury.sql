-- migrations/0018_player_injury.sql
PRAGMA foreign_keys = ON;

ALTER TABLE nhl_players ADD COLUMN injury_status      TEXT NOT NULL DEFAULT '';
ALTER TABLE nhl_players ADD COLUMN injury_description TEXT NOT NULL DEFAULT '';
