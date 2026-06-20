# Gameplay Depth — Design Spec
**Date:** 2026-06-19
**Status:** Approved

## Context

The app currently supports drafting rosters, tracking live NHL stats, and viewing league standings. Engagement drops between draft day and final standings because managers have nothing to do — no weekly competition, no roster decisions, no transactions. This spec adds the full gameplay loop: head-to-head weekly matchups, active/bench lineup management, a waiver wire for roster turnover, and a trade system.

The target season type is **regular season** (long season, high player turnover). Both phases must also work with the existing playoffs mode.

---

## Phase 1 — Head-to-Head Matchups + Active Lineup

### Overview

Each league runs on weekly scoring periods. Two teams are paired each week; the team with more fantasy points from their **active** players wins the matchup. Standings track W/L/T record instead of (or alongside) total points.

### Scoring Period Model

- Commissioner sets the season start date and number of weeks when creating or configuring the league.
- A round-robin schedule is generated automatically: every team plays every other team once before the schedule repeats.
- Each period has a **lineup lock time** (default: the start of the first NHL game day in that week, e.g. Monday 7:00 PM ET). After lock, active/bench designations cannot be changed until the next period opens.
- Stats accumulated during `period.start_date` → `period.end_date` (inclusive) count toward that matchup.

### Active Lineup Slots

Active slot limits are configurable per league via `config_json` with defaults:

| Position | Max Roster | Active Slots |
|----------|-----------|--------------|
| Forwards | 10 | 6 |
| Defense  | 5  | 3 |
| Goalies  | 3  | 2 |

Managers must fill all active slots. Empty slots score zero. Over-limit rosters are blocked at draft/waiver time (existing constraint stays).

### New Database Tables (migrations)

```sql
-- Migration 0011
CREATE TABLE matchup_periods (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id   INTEGER NOT NULL,
  period_num  INTEGER NOT NULL,
  start_date  TEXT NOT NULL,   -- ISO date 'YYYY-MM-DD'
  end_date    TEXT NOT NULL,
  lock_time   DATETIME,        -- NULL = no lock
  FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE,
  UNIQUE(league_id, period_num)
);

CREATE TABLE matchups (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id      INTEGER NOT NULL,
  period_id      INTEGER NOT NULL,
  home_team_id   INTEGER NOT NULL,
  away_team_id   INTEGER NOT NULL,
  home_score     REAL NOT NULL DEFAULT 0,
  away_score     REAL NOT NULL DEFAULT 0,
  winner_team_id INTEGER,      -- NULL = in progress or tie
  FOREIGN KEY (league_id)      REFERENCES leagues(id)   ON DELETE CASCADE,
  FOREIGN KEY (period_id)      REFERENCES matchup_periods(id) ON DELETE CASCADE,
  FOREIGN KEY (home_team_id)   REFERENCES teams(id),
  FOREIGN KEY (away_team_id)   REFERENCES teams(id)
);

-- Per-period active slot assignments. One row per player per period.
-- is_active = 1 → points count; 0 → bench (tracked but don't score).
CREATE TABLE active_roster (
  team_id    INTEGER NOT NULL,
  player_id  INTEGER NOT NULL,
  period_id  INTEGER NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (team_id, player_id, period_id),
  FOREIGN KEY (team_id)  REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (period_id) REFERENCES matchup_periods(id) ON DELETE CASCADE
);

-- Schema change: add waiver_priority to league_members (used in Phase 2 too)
ALTER TABLE league_members ADD COLUMN waiver_priority INTEGER NOT NULL DEFAULT 0;
```

`config_json` on `leagues` gains new optional keys:
```json
{
  "active_slots": { "F": 6, "D": 3, "G": 2 },
  "lineup_lock_hour_utc": 23,
  "trade_veto_hours": 24
}
```

### New API Endpoints (worker/index.js)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/leagues/:id/schedule/generate` | Commissioner generates round-robin period schedule |
| GET  | `/leagues/:id/schedule` | All matchup periods + matchups |
| GET  | `/leagues/:id/matchups/current` | Current week's matchup for the requesting team |
| GET  | `/leagues/:id/matchups/:periodId` | All matchups for a given period |
| GET  | `/leagues/:id/teams/:teamId/lineup/:periodId` | Active/bench split for a team in a period |
| PUT  | `/leagues/:id/teams/:teamId/lineup/:periodId` | Set active players (array of player IDs) — blocked after lock time |
| POST | `/leagues/:id/matchups/score` | Recalculate and persist matchup scores (called by cron + on-demand) |

### Scoring Logic Changes

The existing `calculateFantasyPoints()` logic in `worker/index.js` is unchanged. The scoring endpoint wraps it with an active-player filter:

```
for each matchup in current period:
  for each team (home, away):
    active_player_ids = SELECT player_id FROM active_roster
                        WHERE team_id = ? AND period_id = ? AND is_active = 1
    score = sum of calculateFantasyPoints(player) for player in active_player_ids
  persist home_score, away_score, winner_team_id to matchups row
```

Goalie GAA/SV% rankings are scoped to the active goalies pool per league (same as today but filtered to active only).

### New Frontend Pages/Components

| Path | Component | Description |
|------|-----------|-------------|
| `/leagues/:id/matchup` | `MatchupPage` | Current week H2H score vs. opponent, live updating |
| `/leagues/:id/lineup` | `LineupPage` | Active/bench toggle per player per position |
| `/leagues/:id/schedule` | `SchedulePage` | Full season schedule grid |
| `/leagues/:id/standings` | `StandingsPage` (update) | Add W/L/T columns; total points becomes a tiebreaker |
| — | `CommissionerDashboard` (update) | Add "Generate Schedule" button with week count + start date inputs |

**Lineup page UX:** Players grouped by position (F / D / G). Each card has an Active/Bench toggle. Active count shown per position (e.g. "6 / 6 F active"). Save button submits the whole lineup as one PUT. After lock time, toggles are disabled and a countdown to next unlock is shown.

---

## Phase 2 — Waiver Wire + Trades

### Overview

Managers can drop players to waivers (24h claim window) or to free agency (instant pickup). They can also propose multi-player trades with other teams; commissioner has a configurable veto window before execution.

### Waiver Wire

**Flow:**
1. Manager drops a player → player enters waivers with a 24h expiry.
2. Any team can submit a claim (player to add + player to drop).
3. Nightly cron (already exists in `wrangler.toml`) processes all expired claims in `waiver_priority` order (1 = highest). First valid claim wins; claiming team drops to last priority.
4. If no claim, player becomes a free agent — available instantly to any team via a "Pick Up" button (no priority consumed).

**Priority system:** Initialized in reverse draft order (last pick = highest priority). Resets at commissioner's discretion.

### Trade System

**Flow:**
1. Team A proposes: "I give [Player X] for your [Player Y]." Multi-player supported.
2. Team B sees the proposal in their Trade Inbox → Accept / Reject / Counter.
3. On acceptance, trade enters a commissioner veto window (`trade_veto_hours` from `config_json`, default 24h).
4. After veto window passes without veto, the trade executes: `team_players` rows are updated atomically.
5. Commissioner can veto at any point during the window → status = `vetoed`, rosters unchanged.

### New Database Tables (migrations)

```sql
-- Migration 0012

-- Tracks all dropped players. Status transitions: waivers → free_agent (cron after deadline).
-- Removing a player from team_players AND inserting here are done atomically on drop.
CREATE TABLE dropped_players (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id           INTEGER NOT NULL,
  player_id           INTEGER NOT NULL,
  player_name         TEXT NOT NULL,
  player_meta_json    TEXT NOT NULL DEFAULT '{}',  -- position, nhl_team, headshot_url
  dropped_by_team_id  INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'waivers',  -- waivers | free_agent | claimed
  waiver_deadline     DATETIME,   -- NULL = was already a free agent drop (instant)
  dropped_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (league_id)          REFERENCES leagues(id) ON DELETE CASCADE,
  FOREIGN KEY (dropped_by_team_id) REFERENCES teams(id)
);

CREATE TABLE waiver_claims (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id        INTEGER NOT NULL,
  team_id          INTEGER NOT NULL,
  dropped_player_id INTEGER NOT NULL,    -- references dropped_players.id
  drop_player_id   INTEGER,              -- team_players.player_id to drop on success
  priority_at_time INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | denied | expired
  processed_at     DATETIME,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (league_id)         REFERENCES leagues(id)      ON DELETE CASCADE,
  FOREIGN KEY (team_id)           REFERENCES teams(id)        ON DELETE CASCADE,
  FOREIGN KEY (dropped_player_id) REFERENCES dropped_players(id) ON DELETE CASCADE
);

CREATE TABLE trade_proposals (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id           INTEGER NOT NULL,
  proposing_team_id   INTEGER NOT NULL,
  receiving_team_id   INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  -- pending | accepted | rejected | countered | vetoed | executed | expired
  veto_deadline       DATETIME,
  expires_at          DATETIME NOT NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (league_id)          REFERENCES leagues(id) ON DELETE CASCADE,
  FOREIGN KEY (proposing_team_id)  REFERENCES teams(id),
  FOREIGN KEY (receiving_team_id)  REFERENCES teams(id)
);

CREATE TABLE trade_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id    INTEGER NOT NULL,
  from_team_id INTEGER NOT NULL,
  player_id   INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  FOREIGN KEY (trade_id)     REFERENCES trade_proposals(id) ON DELETE CASCADE,
  FOREIGN KEY (from_team_id) REFERENCES teams(id)
);
```

### New API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET  | `/leagues/:id/waivers` | All rows from `dropped_players` where status = 'waivers' or 'free_agent' |
| POST | `/leagues/:id/waivers/claim` | Submit a claim `{ dropped_player_id, drop_player_id }` |
| DELETE | `/leagues/:id/waivers/claim/:claimId` | Cancel a pending claim |
| POST | `/leagues/:id/players/:playerId/drop` | Remove from `team_players`, insert into `dropped_players` (status = 'waivers') |
| POST | `/leagues/:id/free-agents/:droppedPlayerId/pickup` | Instant add from free_agent status; removes `dropped_players` row, adds to `team_players` |
| GET  | `/leagues/:id/trades` | All trades for the league |
| POST | `/leagues/:id/trades` | Propose a trade `{ receiving_team_id, offering: [ids], requesting: [ids] }` |
| PUT  | `/leagues/:id/trades/:tradeId/accept` | Accept proposal → sets veto deadline |
| PUT  | `/leagues/:id/trades/:tradeId/reject` | Reject proposal |
| PUT  | `/leagues/:id/trades/:tradeId/counter` | Counter with a new proposal (creates new trade row) |
| PUT  | `/leagues/:id/trades/:tradeId/veto` | Commissioner veto |

### Cron Job Additions (wrangler.toml already has cron trigger)

The existing hourly cron handler in `worker/index.js` gains two new jobs:
- **Waiver processing:** Find all `pending` claims where the 24h window has closed → resolve by priority → update `team_players`, set claim `status`.
- **Trade execution:** Find all `accepted` trades where `veto_deadline` has passed and status is still `accepted` → atomically swap `team_players` rows → set status to `executed`.

### New Frontend Pages/Components

| Path | Component | Description |
|------|-----------|-------------|
| `/leagues/:id/waivers` | `WaiverWirePage` | Browseable list of dropped/free-agent players; submit claim or instant pickup |
| `/leagues/:id/trades` | `TradesPage` | Outgoing proposals + incoming inbox; propose new trade |
| — | `TradeProposalModal` | Multi-step: pick players to offer → pick players to request → confirm |
| — | `CommissionerDashboard` (update) | Pending trade veto panel; reset waiver priorities button |

---

## Verification

**Phase 1:**
- Create a 4-team test league, generate a 3-week schedule → confirm round-robin matchups are created correctly with no team playing itself.
- Set active lineup, verify bench players' points are excluded from matchup score.
- Advance past lineup lock time → confirm lineup edits are rejected with a clear error.
- Check standings page shows W/L/T after matchup scores are calculated.

**Phase 2:**
- Drop a player → confirm they appear on waivers with a 24h expiry.
- Submit two claims from different teams → trigger cron processing → confirm higher-priority team receives the player.
- After claim, confirm claiming team's waiver priority drops to last.
- Propose a trade, accept it → wait for veto window → confirm `team_players` rows are swapped.
- Commissioner veto path: accept a trade, immediately veto → confirm rosters unchanged.

---

## Migration Order

```
0011_matchup_periods.sql   — matchup_periods, matchups, active_roster tables; waiver_priority col
0012_transactions.sql      — waiver_claims, trade_proposals, trade_items tables
```

Both migrations are additive (no drops, no breaking changes to existing tables).
