PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS leagues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL,
  season TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  is_locked INTEGER NOT NULL DEFAULT 0,
  invite_code TEXT UNIQUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS league_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',   -- 'commissioner' | 'member'
  joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(league_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_members_user ON league_members(user_id);
CREATE INDEX IF NOT EXISTS idx_members_league ON league_members(league_id);

CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL,
  code TEXT NOT NULL UNIQUE,
  created_by INTEGER NOT NULL,
  email TEXT,
  max_uses INTEGER,                      -- NULL = unlimited
  use_count INTEGER NOT NULL DEFAULT 0,
  expires_at DATETIME,
  revoked_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_invites_league ON invites(league_id);
