PRAGMA foreign_keys = ON;

CREATE TABLE auction_sessions (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id               INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  status                  TEXT NOT NULL DEFAULT 'pending',
  budget_per_team         INTEGER NOT NULL DEFAULT 1000,
  bid_timer_seconds       INTEGER NOT NULL DEFAULT 30,
  draft_order_json        TEXT NOT NULL DEFAULT '[]',
  current_nominator_idx   INTEGER NOT NULL DEFAULT 0,
  current_nomination_json TEXT,
  started_at              TEXT,
  ended_at                TEXT,
  UNIQUE(league_id)
);

CREATE TABLE auction_picks (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_session_id    INTEGER NOT NULL REFERENCES auction_sessions(id) ON DELETE CASCADE,
  player_id             INTEGER NOT NULL,
  player_name           TEXT NOT NULL,
  player_meta_json      TEXT NOT NULL DEFAULT '{}',
  team_id               INTEGER NOT NULL,
  amount                INTEGER NOT NULL,
  nominated_by_team_id  INTEGER NOT NULL,
  pick_number           INTEGER NOT NULL,
  picked_at             TEXT NOT NULL,
  UNIQUE(auction_session_id, player_id)
);

CREATE TABLE auction_budgets (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_session_id    INTEGER NOT NULL REFERENCES auction_sessions(id) ON DELETE CASCADE,
  team_id               INTEGER NOT NULL,
  budget_remaining      INTEGER NOT NULL,
  UNIQUE(auction_session_id, team_id)
);

CREATE TABLE auction_player_rankings (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_session_id    INTEGER NOT NULL REFERENCES auction_sessions(id) ON DELETE CASCADE,
  player_id             INTEGER NOT NULL,
  player_name           TEXT NOT NULL,
  player_meta_json      TEXT NOT NULL DEFAULT '{}',
  global_rank           INTEGER NOT NULL,
  UNIQUE(auction_session_id, player_id)
);
