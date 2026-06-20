# Auction Draft Design

**Date:** 2026-06-20
**Branch:** feature/auction-draft (to be created from feature/gameplay-depth)

---

## Goal

Add a real-time auction draft mode where teams take turns nominating players and all teams bid simultaneously. Each team has a $1,000 budget (commissioner-configurable). The highest bidder when the countdown expires wins the player.

---

## Architecture

The auction draft follows the same infrastructure pattern as the live snake draft:

- **Worker REST routes** manage session lifecycle (create, order, start, pause, resume)
- **`AuctionRoom` Durable Object** (`worker/auction-room.js`) owns all real-time state and drives the nomination cycle
- **DO Alarm API** (`storage.setAlarm`) handles the bid countdown — resets on each new bid
- **WebSocket connections** proxied through the Worker to the DO (same `X-League-Id / X-User-Id / X-Team-Id / X-Is-Commissioner` header pattern)

### Nomination cycle

1. Current nominator sends `{ type: 'nominate', playerId, playerName, playerMeta, openingBid }` (openingBid ≥ 1)
2. DO validates, stores nomination in memory and D1, sets alarm for `bid_timer_seconds`, broadcasts state to all clients
3. Any team with sufficient budget sends `{ type: 'bid', amount }` (must exceed current bid); DO resets alarm each time
4. Alarm fires with no new bid → `awardCurrentNomination()`:
   - Writes D1 batch: INSERT auction_picks, INSERT OR IGNORE team_players (position_detail=''), UPDATE auction_budgets, UPDATE auction_sessions (clear current_nomination_json, advance nominator)
   - Updates in-memory state (pickedPlayerIds, rosters, budgets, picks)
   - Advances `nominatorIdx`, skipping teams whose rosters are full
   - Checks if all teams are full → marks completed
   - Broadcasts updated snapshot

### Auto-nominate

If the current nominator has no active WebSocket connection when it is their turn, the DO auto-nominates the top undrafted player from `globalRankings` at $1. This prevents the draft from stalling on disconnected clients.

### Draft end condition

Draft ends when all teams' rosters are full (total awarded picks = numTeams × (maxF + maxD + maxG)).

---

## Data Model

### Migration (new file: `migrations/0014_auction.sql`)

```sql
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
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_session_id  INTEGER NOT NULL REFERENCES auction_sessions(id) ON DELETE CASCADE,
  player_id           INTEGER NOT NULL,
  player_name         TEXT NOT NULL,
  player_meta_json    TEXT NOT NULL DEFAULT '{}',
  team_id             INTEGER NOT NULL,
  amount              INTEGER NOT NULL,
  nominated_by_team_id INTEGER NOT NULL,
  pick_number         INTEGER NOT NULL,
  picked_at           TEXT NOT NULL,
  UNIQUE(auction_session_id, player_id)
);

CREATE TABLE auction_budgets (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_session_id  INTEGER NOT NULL REFERENCES auction_sessions(id) ON DELETE CASCADE,
  team_id             INTEGER NOT NULL,
  budget_remaining    INTEGER NOT NULL,
  UNIQUE(auction_session_id, team_id)
);

CREATE TABLE auction_player_rankings (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_session_id  INTEGER NOT NULL REFERENCES auction_sessions(id) ON DELETE CASCADE,
  player_id           INTEGER NOT NULL,
  player_name         TEXT NOT NULL,
  player_meta_json    TEXT NOT NULL DEFAULT '{}',
  global_rank         INTEGER NOT NULL,
  UNIQUE(auction_session_id, player_id)
);
```

### Config additions (`DEFAULT_LEAGUE_CONFIG` in `worker/index.js`)

```js
auction_budget: 1000,
bid_timer_seconds: 30,
```

Both are commissioner-configurable via the existing `PUT /api/leagues/:id/config` endpoint.

### current_nomination_json shape

```json
{
  "playerId": 123,
  "playerName": "Connor McDavid",
  "playerMeta": { "position": "F", "nhlTeam": "EDM", "headshotUrl": "...", "crestUrl": "..." },
  "nominatedByTeamId": 4,
  "currentBid": 1,
  "currentBidderId": 4,
  "bidDeadline": "2026-06-20T14:00:00.000Z"
}
```

---

## AuctionRoom Durable Object

**File:** `worker/auction-room.js`
**Binding:** `AUCTION_ROOM` in `wrangler.toml`, keyed `league-{leagueId}`

### Constructor state

```js
this.initialized = false;
this.auctionSessionId = null;
this.leagueId = null;
this.status = 'pending';
this.draftOrder = [];        // [{teamId, teamName}]
this.nominatorIdx = 0;
this.totalTeams = 0;
this.timerSeconds = 30;
this.capsF = 10; this.capsD = 5; this.capsG = 3;
this.budgets = new Map();    // teamId -> remaining integer
this.rosters = new Map();    // teamId -> {F, D, G}
this.picks = [];             // completed awards
this.teamNames = new Map();  // teamId -> name
this.currentNomination = null;
this.pickedPlayerIds = new Set();
this.globalRankings = [];    // ordered by global_rank
this.clients = new Map();    // WebSocket -> {teamId, userId, isCommissioner}
```

### fetch(request)

- `POST /pause` — deleteAlarm, status='paused', broadcastAll
- `POST /alarm-reset` — rehydrate if needed, re-read D1 status + bid_deadline, setAlarm if active and nomination in flight
- WebSocket upgrade — read X-headers, accept WS, store in clients, send snapshot

### alarm()

If `status === 'active'` and `currentNomination !== null` → `awardCurrentNomination()`

If `status === 'active'` and `currentNomination === null` → trigger auto-nominate for current nominator

### rehydrate(leagueId)

Load from D1: auction_sessions, leagues config (timerSeconds, caps, budgetPerTeam), team names, auction_picks (rebuild pickedPlayerIds + rosters + budgets), auction_budgets, auction_player_rankings. Set `this.initialized = true`.

### handleMessage(ws, sender, msg)

Switch on `msg.type`: `nominate`, `bid`, `pause`, `resume`

### handleNominate(ws, sender, msg)

Validations (reject with `{type:'error'}` on failure):
- `status === 'active'`
- No nomination currently in flight (`currentNomination === null`)
- Sender's teamId === `draftOrder[nominatorIdx].teamId`
- Player not in `pickedPlayerIds`
- `openingBid >= 1`
- Bid floor: `openingBid <= budget - remainingSlots + 1` where `remainingSlots = (capsF+capsD+capsG) - rosterTotal`

On success: store nomination in memory + write `current_nomination_json` to D1 + set alarm + broadcastAll

### handleBid(ws, sender, msg)

Validations:
- `status === 'active'`
- Nomination in flight
- Sender's team has roster slots remaining
- `amount > currentNomination.currentBid`
- Bid floor: `amount <= senderBudget - senderRemainingSlots + 1`
- Position cap: sender's roster for the nominated player's position < cap

On success: update `currentNomination` in memory, reset alarm (`deleteAlarm + setAlarm`), write `current_nomination_json` to D1, broadcastAll

### awardCurrentNomination()

D1 batch:
1. `INSERT INTO auction_picks ...`
2. `INSERT OR IGNORE INTO team_players (league_id, team_id, player_id, player_name, position, position_detail, ...) VALUES (...)`
3. `UPDATE auction_budgets SET budget_remaining = budget_remaining - ? WHERE auction_session_id = ? AND team_id = ?`
4. `UPDATE auction_sessions SET current_nomination_json = NULL, current_nominator_idx = ?, ended_at = ? WHERE id = ?`

Update in-memory state: pickedPlayerIds, rosters, budgets, picks, nominatorIdx.

Advance nominator: increment `nominatorIdx % totalTeams`, skip teams whose rosters are full. If all teams are full → set `status = 'completed'`, update D1, deleteAlarm, broadcastAll and return.

After award: check if current nominator is connected; if not → `autoNominate()`; else broadcastAll (client will see it's their turn and can nominate)

### autoNominate()

Find the first player in `globalRankings` not in `pickedPlayerIds` whose position the nominating team still has roster space for (so if the auto-nominated player goes unbid, the nominating team can receive the award at $1). If no eligible player exists → mark draft complete. Otherwise call `handleNominate` internally with `{playerId, playerName, playerMeta, openingBid: 1}` as the current nominator's team.

### snapshot(ws)

```js
{
  status,
  nominatorIdx,
  currentNominatorTeamId: draftOrder[nominatorIdx]?.teamId ?? null,
  currentNomination,          // full object or null
  draftOrder,                 // [{teamId, teamName}]
  picks,                      // all awarded picks
  budgets: [...budgets],      // [{teamId, budgetRemaining}]
  rosters: [...rosters],      // [{teamId, F, D, G}]
  available: globalRankings.filter(r => !pickedPlayerIds.has(r.playerId)).slice(0, 50),
  myBudget: budgets.get(sender.teamId) ?? null,
  myRoster: rosters.get(sender.teamId) ?? null,
}
```

### send(ws, msg) / broadcastAll()

Silent try/catch on send. broadcastAll iterates clients and sends `snapshot(ws)` to each.

---

## REST Routes

All under `/api/leagues/:id/auction/` in `worker/index.js`, inserted before `// ── Waivers`. All use `loadLeagueContext + ctx.error guard + parseId`.

| Method | Path | Commissioner? | Description |
|--------|------|---------------|-------------|
| `POST` | `/auction/session` | Yes | Create session (or reset pending). If existing with status ≠ 'pending' → 400 |
| `GET` | `/auction/session` | No | Returns session, picks, myBudget, myRoster |
| `PUT` | `/auction/session/order` | Yes | Set draft order; validates all teamIds; rejects if status ≠ 'pending' |
| `POST` | `/auction/session/randomize` | Yes | Shuffle order; rejects if status ≠ 'pending' |
| `POST` | `/auction/session/start` | Yes | Seed rankings (same NHL API as snake draft, chunked ≤100), init budgets for all teams, set status='active', trigger DO `/alarm-reset` |
| `GET` | `/auction/ws` | No | WS proxy → `env.AUCTION_ROOM.get(id).fetch()` with X-headers |
| `POST` | `/auction/session/pause` | Yes | Write status='paused' to D1, call DO `/pause` |
| `POST` | `/auction/session/resume` | Yes | Set new bid_deadline, write status='active' to D1, call DO `/alarm-reset` |

**Stalled-auction cron recovery** (in `scheduled`): after executeTrades try/catch, check for active auction_sessions where `current_nomination_json` has a `bidDeadline` older than 2 minutes; call DO `/alarm-reset`.

**DO binding** in `wrangler.toml`:
```toml
[[durable_objects.bindings]]
name = "AUCTION_ROOM"
class_name = "AuctionRoom"
```

Re-export in `worker/index.js`:
```js
export { AuctionRoom } from './auction-room.js';
```

---

## Frontend

### New files

**`client/src/hooks/useAuctionSocket.js`**
Identical pattern to `useDraftSocket` — connects to `/api/leagues/:id/auction/ws`, exponential backoff reconnect (5 retries, base 100ms, max 10s), returns `{ state, send, connected, error }`.

**`client/src/pages/AuctionPage.jsx`**

*Pending state — PreAuctionLobby:*
- Commissioner: Create Session button, draft order list (drag-to-reorder or arrow buttons), Randomize button, Start Auction button (disabled until order is full)
- Non-commissioner: "Waiting for commissioner to start the auction"

*Active state — live auction room:*

- **Nomination panel** (top/center): player card (headshot, name, position, NHL team), current bid amount, current bidder team name, countdown timer bar (green → orange <10s → red <5s), "SOLD" flash on award
- **Nominate panel**: shown only when `currentNominatorTeamId === myTeamId` AND `currentNomination === null`. Contains player search (filters `available` list), opening bid input (min $1, max = budget floor), "Nominate" button
- **Bid controls**: "+ Raise" button showing next valid bid amount (`currentBid + 1`). Disabled when: roster full, insufficient budget floor headroom, or it's own nomination with no other bidder yet (can't bid against yourself unless someone else has bid)
- **Teams sidebar**: each team — team name, budget remaining ($X), roster slots filled (Y/18)
- **Picks feed**: scrollable list of awarded players — player name · position · team name · $amount

*Completed state:* "Auction Complete" banner + full picks summary table

### Modified files

**`client/src/api.js`** — add `api.leagues.auction` object:
```js
auction: {
  getSession: (id) => get(`/api/leagues/${id}/auction/session`),
  create:     (id) => post(`/api/leagues/${id}/auction/session`),
  setOrder:   (id, order) => put(`/api/leagues/${id}/auction/session/order`, { order }),
  randomize:  (id) => post(`/api/leagues/${id}/auction/session/randomize`),
  start:      (id) => post(`/api/leagues/${id}/auction/session/start`),
  pause:      (id) => post(`/api/leagues/${id}/auction/session/pause`),
  resume:     (id) => post(`/api/leagues/${id}/auction/session/resume`),
  connect:    (id) => new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/leagues/${id}/auction/ws`),
},
```

**`client/src/App.jsx`** — add `<Route path="auction" element={<AuctionPage />} />`

**`client/src/components/LeagueLayout.jsx`** — "Auction" NavLink after "Draft"

**`client/src/pages/CommissionerDashboard.jsx`** — Auction Setup section:
- Auction Budget input (default 1000, saves via `api.leagues.update` with `auction_budget`)
- Bid Timer input (default 30, saves with `bid_timer_seconds`)
- Draft order controls + Start Auction button (same pattern as Draft Setup)

---

## Global Constraints

- `auction_budget` default: **1000** (integer, dollars)
- `bid_timer_seconds` default: **30** (integer, seconds)
- Minimum bid: **$1**
- Bid floor formula: `maxBid = budgetRemaining - remainingRosterSlots + 1`
- `remainingRosterSlots = (capsF + capsD + capsG) - (F + D + G)` for that team
- Position used for cap check comes from server-side `globalRankings`, not client `playerMeta` (same security fix as snake draft)
- DO keyed: `league-{leagueId}` on `AUCTION_ROOM` binding
- `position_detail = ''` on all `team_players` inserts
- Rankings seeded in chunks of ≤100 D1 statements
- All WS sends in silent try/catch
- Stalled-auction threshold: bid_deadline older than 2 minutes
