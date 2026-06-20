PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS dropped_players (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id           INTEGER NOT NULL,
  player_id           INTEGER NOT NULL,
  player_name         TEXT NOT NULL,
  player_meta_json    TEXT NOT NULL DEFAULT '{}',
  dropped_by_team_id  INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'waivers',
  waiver_deadline     DATETIME,
  dropped_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (league_id)          REFERENCES leagues(id) ON DELETE CASCADE,
  FOREIGN KEY (dropped_by_team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS waiver_claims (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id         INTEGER NOT NULL,
  team_id           INTEGER NOT NULL,
  dropped_player_id INTEGER NOT NULL,
  drop_player_id    INTEGER,
  priority_at_time  INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  processed_at      DATETIME,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (league_id)         REFERENCES leagues(id)         ON DELETE CASCADE,
  FOREIGN KEY (team_id)           REFERENCES teams(id)           ON DELETE CASCADE,
  FOREIGN KEY (dropped_player_id) REFERENCES dropped_players(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS trade_proposals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id         INTEGER NOT NULL,
  proposing_team_id INTEGER NOT NULL,
  receiving_team_id INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  veto_deadline     DATETIME,
  expires_at        DATETIME NOT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (league_id)         REFERENCES leagues(id) ON DELETE CASCADE,
  FOREIGN KEY (proposing_team_id) REFERENCES teams(id),
  FOREIGN KEY (receiving_team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS trade_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id     INTEGER NOT NULL,
  from_team_id INTEGER NOT NULL,
  player_id    INTEGER NOT NULL,
  player_name  TEXT NOT NULL,
  FOREIGN KEY (trade_id)     REFERENCES trade_proposals(id) ON DELETE CASCADE,
  FOREIGN KEY (from_team_id) REFERENCES teams(id)
);
