# Live Draft Room — Design Spec

**Date:** 2026-06-19  
**Scope:** Snake draft for NHL playoff fantasy leagues — real-time pick room, pre-rank queue, commissioner controls, auto-pick.  
**Out of scope:** Mock draft tool, auction draft (separate specs).

---

## Overview

A real-time snake draft room where all league managers connect simultaneously via WebSocket, watch picks land instantly, manage a personal wish-list queue, and make picks from a live available-players panel. The server-side pick timer runs inside a Cloudflare Durable Object so it is authoritative and immune to client clock drift.

---

## Architecture

### Three-layer design

**Durable Object (`DraftRoom`)** — one instance per league, keyed by `league-{leagueId}`. Holds all in-memory draft state. Manages WebSocket connections, runs the pick timer via the DO Alarm API, processes picks and queue updates, and broadcasts a full state snapshot to every connected client on each change. Writes to D1 on every pick for persistence. Rehydrates from D1 on cold start.

**Worker (`worker/index.js`)** — handles all REST routes (session setup, order management, start/pause/resume). Proxies the WebSocket upgrade to the DO via `env.DRAFT_ROOM.get(id).fetch(request)`. The DO has direct access to `env.DB` (D1 bindings are available to DOs in the same worker script).

**D1** — persistent source of truth for sessions, picks, queues, and seeded player rankings. The DO reads D1 on cold start and writes on every pick.

### New file

`worker/draft-room.js` — exports the `DraftRoom` class. Imported and re-exported from `worker/index.js` so Cloudflare can find it.

### wrangler.toml additions

```toml
[[durable_objects.bindings]]
name = "DRAFT_ROOM"
class_name = "DraftRoom"

[[migrations]]
tag = "v1"
new_classes = ["DraftRoom"]
```

---

## Data Model

### Migration: `migrations/0013_draft.sql`

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS draft_sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id         INTEGER NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending|active|paused|completed
  draft_order_json  TEXT NOT NULL DEFAULT '[]',       -- JSON [teamId, teamId, ...]
  current_pick      INTEGER NOT NULL DEFAULT 0,       -- 0-based overall pick index
  total_picks       INTEGER NOT NULL DEFAULT 0,       -- rounds × num_teams
  pick_deadline     DATETIME,                         -- ISO8601 when current pick expires
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
```

### Config addition

`DEFAULT_LEAGUE_CONFIG` gains `pick_timer_seconds: 90`. `mergeConfig` gains `pick_timer_seconds: parsed.pick_timer_seconds ?? d.pick_timer_seconds`.

### Snake draft pick → team mapping (pure math, no DB)

```
numTeams    = draftOrder.length
round       = Math.floor(overall / numTeams) + 1          // 1-based
pickInRound = overall % numTeams                          // 0-based
teamIndex   = (round % 2 === 1)
              ? pickInRound
              : (numTeams - 1 - pickInRound)
currentTeam = draftOrder[teamIndex]
```

`total_picks = rounds × numTeams` where `rounds = maxF + maxD + maxG` from the league's merged config.

---

## Durable Object

### File: `worker/draft-room.js`

#### In-memory state

```js
{
  leagueId,
  status,           // 'pending' | 'active' | 'paused' | 'completed'
  draftOrder,       // [teamId, ...]  (ordered pick sequence)
  numTeams,
  currentPick,      // 0-based overall pick index
  totalPicks,
  timerSeconds,
  pickDeadline,     // ms timestamp (Date.now()-style)
  pickedPlayerIds,  // Set<number> — fast duplicate guard
  queues,           // Map<teamId, [{playerId, playerName, position, nhlTeam, headshotUrl, crestUrl}]>
  globalRankings,   // [{playerId, playerName, position, nhlTeam, headshotUrl, crestUrl}] ordered by global_rank
  teamRosters,      // Map<teamId, {F: count, D: count, G: count}> — for auto-pick position need
  clients,          // Map<WebSocket, { teamId, userId, isCommissioner }>
  initialized,      // boolean — false until first rehydration from D1
}
```

#### Cold start / rehydration

On the first `fetch()` after eviction (`!this.initialized`):
1. `SELECT * FROM draft_sessions WHERE league_id = ?`
2. `SELECT * FROM draft_picks WHERE draft_session_id = ?` — rebuild `pickedPlayerIds` and `teamRosters`
3. `SELECT * FROM draft_queues WHERE draft_session_id = ? ORDER BY team_id, rank_order`
4. `SELECT * FROM draft_player_rankings WHERE draft_session_id = ? ORDER BY global_rank`
5. Set `this.initialized = true`

The alarm is **not** rescheduled on rehydration. The Worker's hourly cron detects stalled active drafts (status='active', pick_deadline in the past by >2 min) and resets the alarm by calling `POST /api/leagues/:id/draft/session/resume` internally.

#### WebSocket upgrade

```
fetch(request):
  [WebSocketPair] = new WebSocketPair()
  server.accept()
  parse userId, teamId, isCommissioner from request headers (set by Worker before proxying)
  clients.set(server, { teamId, userId, isCommissioner })
  server.addEventListener('message', ...)
  server.addEventListener('close', () => clients.delete(server))
  send(server, { type: 'state', data: snapshot(server) })
  return new Response(null, { status: 101, webSocket: client })
```

#### Message protocol

**Client → DO:**

| Message | Validation | Effect |
|---|---|---|
| `{ type: 'pick', playerId, playerName, playerMeta }` | It's sender's turn; player not in `pickedPlayerIds`; status='active' | Write pick to D1; add to `team_players`; advance pick; reschedule alarm; broadcast state |
| `{ type: 'queue_add', playerId, playerName, playerMeta }` | Player not already in sender's queue | Append to in-memory queue; async write to D1 |
| `{ type: 'queue_remove', playerId }` | Player in sender's queue | Remove from in-memory queue; async write to D1 |
| `{ type: 'queue_reorder', playerIds }` | `playerIds` is array of player IDs already in sender's queue | Reorder in-memory queue; async write to D1 |
| `{ type: 'pause' }` | Sender `isCommissioner`; status='active' | Cancel alarm; set status='paused'; write to D1; broadcast |
| `{ type: 'resume' }` | Sender `isCommissioner`; status='paused' | Reschedule alarm for `Date.now() + timerSeconds * 1000`; set status='active'; write to D1; broadcast |

Invalid messages receive `{ type: 'error', message: '...' }` back to the sender only; other clients are not notified.

**DO → clients (broadcast):**

The DO sends each client a `{ type: 'state', data: snapshot(ws) }` where `snapshot` is:

```js
{
  status,
  currentPick,
  totalPicks,
  pickDeadline,       // ISO8601 string
  draftOrder,         // [{ teamId, teamName }]
  picks: [...],       // all draft_picks so far, ordered by overall_pick
  myQueue: [...],     // this client's team's queue (client-specific)
  available: [...],   // top 50 undrafted players from globalRankings
}
```

`myQueue` is filtered per-client when building the snapshot — the DO iterates `clients` and sends individually on broadcast.

#### Pick timer (DO Alarm API)

```js
async alarm() {
  if (this.status !== 'active') return;
  if (this.currentPick >= this.totalPicks) return;
  await this.autoPickForCurrentTeam();
  // autoPickForCurrentTeam calls advancePick() which schedules the next alarm
}
```

`advancePick()`:
1. Increment `currentPick`
2. If `currentPick >= totalPicks`: set `status='completed'`, write `completed_at` to D1, broadcast, return
3. Else: `this.pickDeadline = Date.now() + this.timerSeconds * 1000`; `storage.setAlarm(this.pickDeadline)`; broadcast

#### Auto-pick logic

```
autoPickForCurrentTeam(teamId):
  positionNeed = mostNeededPosition(teamId)       // F, D, or G
  candidate = firstUndraftedQueueEntryAtPosition(teamId, positionNeed)
  if (!candidate):
    candidate = firstUndraftedGlobalRankingAtPosition(positionNeed)
  if (!candidate):
    // fall back to any position with remaining need
    for pos in ['F','D','G'] (skipping positionNeed):
      candidate = firstUndraftedQueueEntryAtPosition(teamId, pos)
               || firstUndraftedGlobalRankingAtPosition(pos)
      if candidate: break
  if (!candidate): mark draft completed (no eligible players remain)
  else: executePick(teamId, candidate, isAutoPick=true)
```

`mostNeededPosition(teamId)`:  
Compare `(cap - current count) / cap` for each position (F=maxF, D=maxD, G=maxG). The position with the highest remaining-fraction is most needed.

#### Persisting picks to D1

On each pick, the DO writes atomically:
```js
await env.DB.batch([
  db.prepare('INSERT INTO draft_picks (...) VALUES (...)').bind(...),
  db.prepare('UPDATE draft_sessions SET current_pick=?, pick_deadline=? WHERE id=?').bind(...),
  db.prepare('INSERT INTO team_players (team_id, player_id, player_name, nhl_team, position, position_detail, headshot_url, crest_url) VALUES (?,?,?,?,?,?,?,?)').bind(...),
])
```

Queue writes to D1 are fire-and-forget (`await` omitted) so they don't block the broadcast.

---

## Worker Routes

All routes follow existing patterns: `loadLeagueContext(db, request, leagueId)`, `ctx.error` guard, `parseId()` on params, `isCommissioner(ctx.league, ctx.role, ctx.user.id)` for commissioner-only endpoints.

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/leagues/:id/draft/session` | Commissioner | Create draft session (error if one already exists with status != 'pending') |
| `PUT` | `/api/leagues/:id/draft/session/order` | Commissioner | Set manual order `{ order: [teamId,...] }` — validates all teamIds belong to league |
| `POST` | `/api/leagues/:id/draft/session/randomize` | Commissioner | Randomly shuffle all league teams into draft order |
| `POST` | `/api/leagues/:id/draft/session/start` | Commissioner | Fetch NHL stats leaderboard → seed `draft_player_rankings` → set `status='active'`, `started_at`, `total_picks`, first `pick_deadline` → trigger DO alarm via DO fetch |
| `GET` | `/api/leagues/:id/draft/session` | Any member | Returns full session row + all picks + caller's queue (for page load / WS reconnect) |
| `GET` | `/api/leagues/:id/draft/ws` | Any member | WebSocket upgrade: set `X-User-Id`, `X-Team-Id`, `X-Is-Commissioner` headers; proxy to DO |
| `POST` | `/api/leagues/:id/draft/session/pause` | Commissioner | Write `status='paused'` to D1; notify DO via internal fetch |
| `POST` | `/api/leagues/:id/draft/session/resume` | Commissioner | Write `status='active'` to D1; notify DO via internal fetch (DO reschedules alarm) |

**No HTTP pick endpoint.** All picks travel over WebSocket only.  
**No HTTP queue endpoints.** Queue mutations travel over WebSocket only; `GET /draft/session` returns the caller's current queue for the initial page load.

### NHL stats seeding (on `start`)

Fetch from the NHL API (`NHL_BASE = 'https://api-web.nhle.com/v1'`):
- Skaters: `GET /skater-stats-leaders/current?categories=points&limit=200` — map to `{ playerId, playerName, position: positionCode (C/L/R → 'F'), nhlTeam, headshotUrl }`
- Goalies: `GET /goalie-stats-leaders/current?categories=wins&limit=30` — map to `{ playerId, playerName, position: 'G', nhlTeam, headshotUrl }`

Insert into `draft_player_rankings` ordered: skaters (by points rank) first, then goalies. `global_rank` is 1-based insertion order.

### Stalled-draft cron recovery

In the existing hourly cron loop (`handleScheduled(event, env, ctx)`), after per-league waivers/trades processing. `env.DRAFT_ROOM` is available because it is bound in `wrangler.toml` and `handleScheduled` receives the same `env` as `fetch`:
```js
// If a draft is active but pick_deadline is >2 min in the past, reset the DO alarm
const stalledDraft = await db.prepare(`
  SELECT id, league_id FROM draft_sessions
  WHERE status = 'active'
    AND league_id = ?
    AND pick_deadline < datetime('now', '-2 minutes')
`).bind(leagueId).first();
if (stalledDraft) {
  const id = env.DRAFT_ROOM.idFromName(`league-${leagueId}`);
  const stub = env.DRAFT_ROOM.get(id);
  await stub.fetch(new Request('https://internal/alarm-reset', { method: 'POST' }));
}
```

---

## Frontend

### Route & nav

`<Route path="draft" element={<DraftPage />} />` nested under `LeagueLayout`. "Draft" nav link added to `LeagueLayout.jsx` nav bar (between Trades and Rules).

### Components

#### `client/src/pages/DraftPage.jsx`

Top-level page. On mount:
1. `GET /api/leagues/:id/draft/session` → initial state (handles `status='pending'` case)
2. Opens WebSocket via `useDraftSocket(leagueId)`
3. On WS `state` message: replaces local state entirely (full snapshot, no merging)

Renders:
- `PreDraftLobby` when `status === 'pending'`
- Three-panel layout when `status === 'active' | 'paused' | 'completed'`

#### `client/src/hooks/useDraftSocket.js`

Custom hook managing WS lifecycle:
- Opens `wss://{host}/api/leagues/{id}/draft/ws`
- Reconnects with exponential backoff (100ms base, ×2 per attempt, max 5 retries then gives up)
- Exposes `{ state, send, connected, error }`
- Closes cleanly on component unmount

#### `client/src/pages/DraftPage.jsx` (three-panel layout)

```
┌──────────────────┬──────────────────────┬───────────────┐
│  Draft Board     │  Available Players   │   My Queue    │
│  (pick grid)     │  (filterable list)   │ (reorderable) │
│                  │                      │               │
│  Timer bar       │                      │               │
└──────────────────┴──────────────────────┴───────────────┘
```

**`DraftBoardGrid`** — `numTeams` columns × `numRounds` rows table. Filled cells: player name + position tag. Current pick cell: pulsing border. Header row: team names, "ON THE CLOCK" badge on active team.

**`DraftTimerBar`** — receives `pickDeadline` (ISO8601). Client derives remaining seconds via `setInterval(1000)`. Bar: amber at ≤20s, red at ≤10s. Shows team name on the clock. Shows "PAUSED" when `status === 'paused'`. Hidden when `status === 'completed'`.

**`DraftAvailablePlayers`** — position tabs (ALL / F / D / G). Name search input. Each row: headshot, name, NHL team, position. Per-row buttons:
- **"+ Queue"** — always enabled unless player already queued or drafted; sends `queue_add` WS message
- **"Draft"** — enabled only when it is this client's team's turn and `status === 'active'`; sends `pick` WS message

**`DraftQueuePanel`** — ordered list of queued players. HTML5 drag-and-drop for reorder (no new library). On drop, sends `queue_reorder`. Row × button sends `queue_remove`. Already-drafted players shown with strikethrough and grey text (not auto-removed — user may want to review).

#### `client/src/pages/DraftPage.jsx` — `PreDraftLobby` (pending state)

Shown when `status === 'pending'`. Lists all teams with their assigned pick slot number (or "–"). Commissioner sees:
- "Randomize Order" button → `POST /draft/session/randomize`
- Numbered pick-slot inputs (or drag-to-reorder) for manual ordering → `PUT /draft/session/order`
- "Start Draft" button (disabled until all teams have a pick position) → `POST /draft/session/start`

Non-commissioners see: team list + "Waiting for commissioner to start the draft."

#### `client/src/pages/CommissionerDashboard.jsx` (additions)

New "Draft Setup" section:
- "Create Draft Session" button (`POST /draft/session`) — disabled if session already exists
- Pick timer input (number, seconds) — saves to league config via existing `PATCH /api/leagues/:id`
- Link to the Draft page

### `client/src/api.js` additions

```js
leagues.draft: {
  getSession:  (id) => request(`/api/leagues/${id}/draft/session`),
  create:      (id) => request(`/api/leagues/${id}/draft/session`, { method: 'POST' }),
  setOrder:    (id, order) => request(`/api/leagues/${id}/draft/session/order`, {
                 method: 'PUT', body: JSON.stringify({ order }) }),
  randomize:   (id) => request(`/api/leagues/${id}/draft/session/randomize`, { method: 'POST' }),
  start:       (id) => request(`/api/leagues/${id}/draft/session/start`, { method: 'POST' }),
  pause:       (id) => request(`/api/leagues/${id}/draft/session/pause`, { method: 'POST' }),
  resume:      (id) => request(`/api/leagues/${id}/draft/session/resume`, { method: 'POST' }),
  connect:     (id) => {
    const host = window.location.host;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return new WebSocket(`${proto}://${host}/api/leagues/${id}/draft/ws`);
  },
}
```

---

## Constraints & invariants

- **No HTTP pick endpoint.** All picks travel over WebSocket only (DO is single source of truth; avoids race conditions with the alarm).
- **No HTTP queue endpoints.** Queue mutations over WebSocket only; initial queue returned in `GET /draft/session`.
- **`is_locked` not enforced during draft.** The league lock controls regular-season roster changes; the draft is a separate pre-season flow. Commissioner starts the draft before `is_locked` is set.
- **One draft session per league** (`UNIQUE(league_id)` on `draft_sessions`). Reset requires deleting the old session (commissioner action, not exposed in this spec — out of scope).
- **`team_players` written on each pick** inside the same `db.batch` as the `draft_picks` INSERT. Draft completes with all rosters already populated.
- **Roster cap enforced on pick** — the DO validates position counts against `maxF`, `maxD`, `maxG` before accepting a pick message. Returns `{ type: 'error' }` if over cap (should not happen in a well-run draft, but guards against edge cases).
- **`position_detail = ''`** set on all `team_players` inserts during the draft (same as waiver/trade flow).
- **Draft page accessible while draft is `completed`** — shows the full board as a recap. Timer hidden.
