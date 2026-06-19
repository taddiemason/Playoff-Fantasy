-- migrations/0011_matchup_periods.sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS matchup_periods (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id   INTEGER NOT NULL,
  period_num  INTEGER NOT NULL,
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  lock_time   DATETIME,
  FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE,
  UNIQUE(league_id, period_num)
);

CREATE TABLE IF NOT EXISTS matchups (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id       INTEGER NOT NULL,
  period_id       INTEGER NOT NULL,
  home_team_id    INTEGER NOT NULL,
  away_team_id    INTEGER NOT NULL,
  home_score      REAL NOT NULL DEFAULT 0,
  away_score      REAL NOT NULL DEFAULT 0,
  winner_team_id  INTEGER,
  FOREIGN KEY (league_id)     REFERENCES leagues(id) ON DELETE CASCADE,
  FOREIGN KEY (period_id)     REFERENCES matchup_periods(id) ON DELETE CASCADE,
  FOREIGN KEY (home_team_id)  REFERENCES teams(id),
  FOREIGN KEY (away_team_id)  REFERENCES teams(id)
);

CREATE INDEX IF NOT EXISTS idx_matchups_league_period ON matchups(league_id, period_id);

CREATE TABLE IF NOT EXISTS active_roster (
  team_id    INTEGER NOT NULL,
  player_id  INTEGER NOT NULL,
  period_id  INTEGER NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (team_id, player_id, period_id),
  FOREIGN KEY (team_id)   REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (period_id) REFERENCES matchup_periods(id) ON DELETE CASCADE
);

ALTER TABLE league_members ADD COLUMN waiver_priority INTEGER NOT NULL DEFAULT 0;
