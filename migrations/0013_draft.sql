PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS draft_sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id         INTEGER NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'pending',
  draft_order_json  TEXT NOT NULL DEFAULT '[]',
  current_pick      INTEGER NOT NULL DEFAULT 0,
  total_picks       INTEGER NOT NULL DEFAULT 0,
  pick_deadline     DATETIME,
  started_at        DATETIME,
  completed_at      DATETIME,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS draft_picks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_session_id  INTEGER NOT NULL,
  league_id         INTEGER NOT NULL,
  team_id           INTEGER NOT NULL,
  player_id         INTEGER NOT NULL,
  player_name       TEXT NOT NULL,
  player_meta_json  TEXT NOT NULL DEFAULT '{}',
  round             INTEGER NOT NULL,
  pick_in_round     INTEGER NOT NULL,
  overall_pick      INTEGER NOT NULL,
  is_auto_pick      INTEGER NOT NULL DEFAULT 0,
  picked_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (draft_session_id) REFERENCES draft_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (league_id)        REFERENCES leagues(id)         ON DELETE CASCADE,
  UNIQUE(draft_session_id, player_id)
);

CREATE TABLE IF NOT EXISTS draft_queues (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_session_id  INTEGER NOT NULL,
  team_id           INTEGER NOT NULL,
  player_id         INTEGER NOT NULL,
  player_name       TEXT NOT NULL,
  player_meta_json  TEXT NOT NULL DEFAULT '{}',
  rank_order        INTEGER NOT NULL,
  FOREIGN KEY (draft_session_id) REFERENCES draft_sessions(id) ON DELETE CASCADE,
  UNIQUE(draft_session_id, team_id, player_id)
);

CREATE TABLE IF NOT EXISTS draft_player_rankings (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_session_id  INTEGER NOT NULL,
  player_id         INTEGER NOT NULL,
  player_name       TEXT NOT NULL,
  player_meta_json  TEXT NOT NULL DEFAULT '{}',
  global_rank       INTEGER NOT NULL,
  FOREIGN KEY (draft_session_id) REFERENCES draft_sessions(id) ON DELETE CASCADE,
  UNIQUE(draft_session_id, player_id)
);
