# Keepers & Dynasty Design

**Date:** 2026-06-20
**Branch:** feature/keepers-dynasty (to be created from feature/gameplay-depth)

---

## Goal

Add keeper and dynasty league formats to the NHL playoff fantasy app. Keeper leagues let teams designate a configurable number of players to carry forward each season (with a choice of cost model). Dynasty leagues auto-keep all players year-over-year and add a supplemental draft for new players plus a taxi squad for over-limit rosters.

---

## Architecture

The league gains two new columns: `league_format` (`'redraft' | 'keeper' | 'dynasty'`) and `phase`, which drives what every page shows and what actions are available.

### Phase State Machine

| Format | Phase sequence |
|--------|---------------|
| Redraft | active → offseason → pre_draft → active |
| Keeper | active → offseason → keeper_window → pre_draft → active |
| Dynasty | active → offseason → supplemental_draft → pre_draft → active |

All phase transitions are commissioner-triggered. `pre_draft` is the window between roster finalization and the season going live:
- **Keeper leagues:** after the keeper window closes, non-keepers purged, draft ready to run
- **Dynasty leagues:** after the supplemental draft completes, teams resolve over-limit rosters before the commissioner activates the season

The existing snake and auction draft infrastructure runs unchanged during `pre_draft` (keeper) and `supplemental_draft` (dynasty) phases — the player pool is filtered to exclude already-kept players.

### Season String

`leagues.season` already stores e.g. `"20242025"`. On "Start New Season", it advances to the next season string (e.g. `"20252026"`) using the same `getCurrentSeason()` logic but incremented by one year.

---

## Data Model

### New migration: `migrations/0015_keepers_dynasty.sql`

```sql
PRAGMA foreign_keys = ON;

-- Phase and format tracking on leagues
ALTER TABLE leagues ADD COLUMN league_format TEXT NOT NULL DEFAULT 'redraft';
-- 'redraft' | 'keeper' | 'dynasty'

ALTER TABLE leagues ADD COLUMN phase TEXT NOT NULL DEFAULT 'active';
-- 'active' | 'offseason' | 'keeper_window' | 'pre_draft' | 'supplemental_draft'

-- Taxi squad flag on team_players (dynasty only)
ALTER TABLE team_players ADD COLUMN is_taxi_squad INTEGER NOT NULL DEFAULT 0;

-- Keeper designations: one row per player a team designates to keep, per season
CREATE TABLE keeper_designations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id         INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_id           INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id         INTEGER NOT NULL,
  player_name       TEXT NOT NULL,
  player_meta_json  TEXT NOT NULL DEFAULT '{}',
  cost_type         TEXT NOT NULL DEFAULT 'free',
  -- 'free' | 'pick_round' | 'auction_inflation' | 'none'
  cost_value        INTEGER NOT NULL DEFAULT 0,
  -- pick_round: the round number; auction_inflation: inflated $ amount
  season            TEXT NOT NULL,
  -- season this designation applies TO (the upcoming season)
  designated_at     TEXT NOT NULL,
  UNIQUE(league_id, team_id, player_id, season)
);

-- Roster snapshots: archived end-of-season rosters
CREATE TABLE roster_snapshots (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id           INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_id             INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id           INTEGER NOT NULL,
  player_name         TEXT NOT NULL,
  player_meta_json    TEXT NOT NULL DEFAULT '{}',
  season              TEXT NOT NULL,
  was_keeper          INTEGER NOT NULL DEFAULT 0,
  keeper_cost_type    TEXT,
  keeper_cost_value   INTEGER,
  snapshotted_at      TEXT NOT NULL
);
```

### Config additions (`DEFAULT_LEAGUE_CONFIG` in `worker/index.js`)

```js
max_keepers: 3,              // keeper format: max designations per team
keeper_cost_type: 'free',    // 'free' | 'pick_round' | 'auction_inflation' | 'none'
keeper_cost_inflation_pct: 20, // auction_inflation only: % markup on previous bid
taxi_squad_size: 3,          // dynasty only: max taxi squad spots per team
```

---

## Keeper Mode Flow

### Setup

Commissioner sets `league_format = 'keeper'` in league settings, along with `max_keepers`, `keeper_cost_type`, and (if applicable) `keeper_cost_inflation_pct`.

### End of Season

Commissioner hits **"End Season"** → `phase = 'offseason'`. Current `team_players` rows snapshotted to `roster_snapshots` (one row per player per team, `was_keeper = 0` initially).

### Keeper Window (`phase = 'keeper_window'`)

Commissioner opens the window. Each team owner sees their current roster and designates up to `max_keepers` players. The UI shows cost per player based on `keeper_cost_type`:

- **free** — no cost shown
- **pick_round** — round the player was originally drafted (looked up from `draft_picks`)
- **auction_inflation** — previous winning bid × (1 + `keeper_cost_inflation_pct` / 100), looked up from `auction_picks`
- **none** — no cost enforced in the app; commissioner handles rules manually

Commissioner sees a readiness panel: each team's name, how many keepers designated, and the max allowed. When satisfied, commissioner closes the window.

### Closing the Window (`phase = 'pre_draft'`)

1. Each designated keeper in `keeper_designations` has its `was_keeper` updated to `1` in `roster_snapshots`
2. `team_players` rows for non-keeper players are deleted
3. `phase = 'pre_draft'`

Commissioner starts the draft normally. The draft player pool excludes players present in `team_players` (already-kept players). `league.season` advances to the next season string when the keeper window closes (at the start of `pre_draft`). When the draft session status reaches `'completed'`, `phase` auto-advances to `'active'`.

---

## Dynasty Mode Flow

### Setup

Commissioner sets `league_format = 'dynasty'` and configures `taxi_squad_size`. No `max_keepers` or cost type needed — all players auto-carry.

### End of Season

Commissioner hits **"End Season"** → `phase = 'offseason'`. All current `team_players` rows snapshotted to `roster_snapshots` (all `was_keeper = 1`). No keeper window — all `team_players` rows stay intact.

### Supplemental Draft (`phase = 'supplemental_draft'`)

Commissioner hits **"Start New Season"** (`POST /season/start`):
1. `league.season` advances to the next season string
2. `phase = 'supplemental_draft'`
3. A draft session is created (commissioner chooses snake or auction format)

The existing draft infrastructure runs unchanged. Player pool = all NHL players **not** in any team's `team_players` for this league. Teams with full rosters can still participate and pick new players — over-limit situations are resolved in the next phase.

### Pre-Draft Window (`phase = 'pre_draft'`)

After the supplemental draft completes, teams over their roster limit must either:
- **Drop players** (removed from `team_players`)
- **Move to taxi squad** (`team_players.is_taxi_squad = 1`)

Taxi squad players count against `taxi_squad_size`, not the main roster cap. The commissioner sees a readiness panel showing each team's main roster count, taxi squad count, and whether they are within limits. **"Activate Season"** is disabled until every team satisfies: `main_roster ≤ (maxF + maxD + maxG)` and `taxi_squad ≤ taxi_squad_size`.

### Activation (`phase = 'active'`)

Commissioner hits **"Activate Season"**. Taxi squad players remain on the team throughout the season and can be promoted to the main roster or dropped at any time via the existing waiver/free-agent flow.

---

## REST Routes

All routes in `worker/index.js`, inserted before `// ── Waivers`. All use `loadLeagueContext + ctx.error guard + parseId + isCommissioner` where required.

| Method | Path | Commissioner? | Description |
|--------|------|---------------|-------------|
| `POST` | `/api/leagues/:id/season/end` | Yes | Snapshot rosters → `phase = 'offseason'` |
| `POST` | `/api/leagues/:id/season/keeper-window/open` | Yes | `phase = 'keeper_window'`; rejects if format ≠ 'keeper' or phase ≠ 'offseason' |
| `POST` | `/api/leagues/:id/season/keeper-window/close` | Yes | Purge non-keepers, update roster_snapshots, `phase = 'pre_draft'` |
| `GET` | `/api/leagues/:id/keepers` | No | List all teams' keeper designations for current season |
| `PUT` | `/api/leagues/:id/keepers` | No (own team) | Designate/update own keepers; validates max_keepers limit and cost |
| `DELETE` | `/api/leagues/:id/keepers/:playerId` | No (own team) | Remove a keeper designation |
| `POST` | `/api/leagues/:id/season/start` | Yes | Advance season string, `phase = 'supplemental_draft'` (dynasty) or `phase = 'pre_draft'` (redraft only); rejects if format = 'keeper' (keeper uses keeper-window/close instead) |
| `POST` | `/api/leagues/:id/season/activate` | Yes | `phase = 'active'`; rejects if any team is over-limit (dynasty) |
| `PUT` | `/api/leagues/:id/taxi` | No (own team) | Move player to/from taxi squad (`is_taxi_squad` toggle) |
| `GET` | `/api/leagues/:id/roster-snapshots` | No | Historical rosters by season (returns grouped by season + team) |

---

## Frontend

### Phase-Aware Banner

Every league page (`LeagueLayout.jsx`) shows a contextual banner based on `phase`:
- `keeper_window` → "Keeper window is open — designate your keepers before the commissioner closes it"
- `supplemental_draft` → "Supplemental draft in progress"
- `pre_draft` → "Season starting soon — finalize your roster" (dynasty: shows if team is over-limit)
- `offseason` → "Season ended — waiting for commissioner to start the next season"

### New `KeepersPage` (`/leagues/:id/keepers`)

**Team owner view (keeper format, phase = keeper_window):**
- Roster list with a "Keep" checkbox per player
- Cost shown per player (based on `keeper_cost_type`)
- Counter showing designations used / max allowed
- Save button

**Commissioner view:**
- All teams listed with their keeper designation progress (X / max_keepers confirmed)
- "Close Keeper Window" button (advances to pre_draft)

**Completed / read-only view (any phase after keeper_window):** shows who each team kept and at what cost.

### CommissionerDashboard — Season Management Section

New card below the existing draft setup sections:

- **League format selector:** Redraft / Keeper / Dynasty
- **Keeper settings** (shown when format = keeper): max keepers input, keeper cost type dropdown, inflation % input (auction_inflation only)
- **Dynasty settings** (shown when format = dynasty): taxi squad size input
- **Season actions** — one button shown based on current phase:
  - `active` → "End Season"
  - `offseason` (keeper) → "Open Keeper Window"
  - `keeper_window` → "Close Keeper Window" (with readiness summary)
  - `offseason` (dynasty) or `pre_draft` (redraft/keeper after draft) → "Start New Season"
  - `supplemental_draft` → (draft is running — no button, link to draft room)
  - `pre_draft` (dynasty) → "Activate Season" (disabled if any team over-limit, readiness table shown)

### TeamPage / RosterPage (dynasty only)

- Taxi squad section below the main roster
- Promote (taxi → main roster) and Drop buttons per taxi player
- Over-limit warning shown in `pre_draft` phase if team exceeds roster cap

### Nav

- "Keepers" nav link added to `LeagueLayout` when `league_format !== 'redraft'`

---

## Global Constraints

- `league_format` default: `'redraft'` (existing leagues unaffected)
- `phase` default: `'active'` (existing leagues unaffected)
- `is_taxi_squad` default: `0` (existing team_players rows unaffected)
- `max_keepers` default: `3`
- `keeper_cost_type` default: `'free'`
- `keeper_cost_inflation_pct` default: `20`
- `taxi_squad_size` default: `3`
- Phase transitions are commissioner-only; all transition endpoints reject with 403 if caller is not commissioner
- Keeper designation (`PUT /keepers`) is team-owner-only: validates `teams.user_id === ctx.user.id`
- Taxi squad toggle (`PUT /taxi`) is team-owner-only; rejects if `is_taxi_squad = 1` and team already at `taxi_squad_size`
- "End Season" (`POST /season/end`) rejects if `phase !== 'active'`
- "Open Keeper Window" rejects if `league_format !== 'keeper'` or `phase !== 'offseason'`
- "Close Keeper Window" rejects if `phase !== 'keeper_window'`
- "Start New Season" rejects if `phase !== 'offseason'` or `league_format = 'keeper'` (keeper format uses keeper-window flow instead)
- Draft session completion (`status = 'completed'`) auto-advances `league.phase` to `'active'` for redraft and keeper formats; for dynasty it advances `phase` to `'pre_draft'`
- "Activate Season" rejects if `phase !== 'pre_draft'` or any team has `main_roster > (maxF+maxD+maxG)` or `taxi_count > taxi_squad_size`
- `roster_snapshots` is append-only; never deleted or updated after creation
- Player pool for all drafts (main + supplemental) excludes `team_players` rows for the current league
- Supplemental draft reuses existing `DraftRoom` / `AuctionRoom` DO and draft session tables unchanged
