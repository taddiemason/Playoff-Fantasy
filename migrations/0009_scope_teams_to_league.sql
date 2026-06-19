-- Scope teams to a league + owning user. The original `teams` table (0001) has a
-- global UNIQUE(name); we need UNIQUE(league_id, name) instead, which requires a
-- table rebuild in SQLite. Existing rows are preserved with NULL league_id/user_id
-- and back-filled into a league by the admin bootstrap endpoint.

PRAGMA defer_foreign_keys = TRUE;

CREATE TABLE teams_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER,
  user_id INTEGER,
  name TEXT NOT NULL,
  owner TEXT DEFAULT '',
  tiebreaker TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(league_id, name)
);

INSERT INTO teams_new (id, name, owner, tiebreaker, created_at)
  SELECT id, name, owner, tiebreaker, created_at FROM teams;

DROP TABLE teams;
ALTER TABLE teams_new RENAME TO teams;

CREATE INDEX IF NOT EXISTS idx_teams_league ON teams(league_id);
CREATE INDEX IF NOT EXISTS idx_teams_user ON teams(user_id);
