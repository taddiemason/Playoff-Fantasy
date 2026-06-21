# Player News & Injury Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface NHL injury status badges on every player row and add a player detail page with news, stats, and recent game log.

**Architecture:** Two new cron functions (`syncInjuries`, `refreshRosteredPlayerLandings`) refresh D1 data hourly. A `getInjuryMap` helper in the worker injects injury fields into all existing player-list routes. A new `PlayerDetailPage` reads the updated `playerDetailMatch GET` route which now includes injury + landing data. A separate `GET /api/leagues/:id/injuries` endpoint provides a lightweight map for Draft and Auction pages whose player pools come from Durable Objects.

**Tech Stack:** Cloudflare Workers + D1 (SQLite), React 18 + React Router v6, NHL Web API (`api-web.nhle.com/v1`)

## Global Constraints

- All route conditions in `worker/index.js` MUST use `request.method` — NEVER a bare `method` variable (causes `ReferenceError` crashing every API request)
- CSS: use CSS variables (`--bg`, `--bg-card`, `--bg-card-hover`, `--bg-input`, `--border`, `--primary`, `--primary-glow`, `--text`, `--text-muted`, `--text-dim`) — never hardcode colors (exception: injury badge background colors are brand-specific: `#ef4444`, `#f97316`, `#991b1b`)
- Injury badge status values: `"IR"`, `"DTD"`, `"LTIR"`, `"OUT"`, or `""` (healthy)
- No test suite exists — verify with `node --check worker/index.js` for syntax + manual browser verification

---

## File Map

| File | Action | Task |
|------|--------|------|
| `migrations/0018_player_injury.sql` | Create | 1 |
| `worker/index.js` | Modify — add 2 functions + wire cron | 2 |
| `worker/index.js` | Modify — add helper + update 6 routes | 3 |
| `client/src/components/PlayerStatusBadge.jsx` | Create | 4 |
| `client/src/App.css` | Modify — add badge styles | 4 |
| `client/src/pages/TeamDetail.jsx` | Modify | 5 |
| `client/src/pages/LineupPage.jsx` | Modify | 5 |
| `client/src/pages/WaiverWirePage.jsx` | Modify | 5 |
| `client/src/pages/AddPlayers.jsx` | Modify | 5 |
| `client/src/pages/PlayerExplorer.jsx` | Modify | 5 |
| `client/src/pages/DraftPage.jsx` | Modify | 5 |
| `client/src/pages/AuctionPage.jsx` | Modify | 5 |
| `client/src/pages/PlayerDetailPage.jsx` | Create | 6 |
| `client/src/api.js` | Modify — add `injuries` method | 6 |
| `client/src/App.jsx` | Modify — add `players/:playerId` route | 6 |

---

### Task 1: D1 Migration — injury columns

**Files:**
- Create: `migrations/0018_player_injury.sql`

**Interfaces:**
- Produces: `nhl_players.injury_status TEXT NOT NULL DEFAULT ''` and `nhl_players.injury_description TEXT NOT NULL DEFAULT ''` columns available to all subsequent tasks

- [ ] **Step 1: Create the migration file**

```sql
-- migrations/0018_player_injury.sql
PRAGMA foreign_keys = ON;

ALTER TABLE nhl_players ADD COLUMN injury_status      TEXT NOT NULL DEFAULT '';
ALTER TABLE nhl_players ADD COLUMN injury_description TEXT NOT NULL DEFAULT '';
```

- [ ] **Step 2: Apply migration to local D1 (if running locally)**

If you have a local D1 database for development, run:
```bash
npx wrangler d1 execute DB --local --file=migrations/0018_player_injury.sql
```
If no local D1 is set up, skip — the migration runs in CI/deploy.

- [ ] **Step 3: Verify migration file syntax (SQL lint)**

Open the file, confirm: two `ALTER TABLE` statements, correct column names, no typos.

- [ ] **Step 4: Commit**

```bash
git add migrations/0018_player_injury.sql
git commit -m "feat: add injury_status and injury_description columns to nhl_players"
```

---

### Task 2: Cron Functions — syncInjuries + refreshRosteredPlayerLandings

**Files:**
- Modify: `worker/index.js`

**Context:**
- `NHL_BASE = 'https://api-web.nhle.com/v1'` is already defined at the top of the file (line ~105)
- `savePlayerLandingSnapshot(db, playerId, landingData, fetchedAt)` already exists (~line 512) — use it
- The `scheduled` handler is at the bottom of the file (~line 3527). The `syncNhlRosters(db)` call is inside a try/catch at ~line 3593. Add the two new cron calls AFTER that block, before the final `computeStandings` call.
- Batch pattern used throughout: `for (let i = 0; i < arr.length; i += 100) { await db.batch(arr.slice(i, i + 100).map(...)) }`

**Interfaces:**
- Consumes: `NHL_BASE`, `savePlayerLandingSnapshot(db, playerId, landingData, fetchedAt)`, D1 tables `nhl_players` and `team_players` and `player_landing_snapshots`
- Produces: `syncInjuries(db)` and `refreshRosteredPlayerLandings(db)` as module-level async functions available to the scheduled handler

- [ ] **Step 1: Add `syncInjuries(db)` function**

Add this function just below `syncNhlRosters` (~line 71) in `worker/index.js`:

```js
async function syncInjuries(db) {
  const res = await fetch(`${NHL_BASE}/injury`, {
    headers: { 'User-Agent': 'PlayoffFantasy/1.0 (Cloudflare Worker)' }
  });
  if (!res.ok) throw new Error(`Injury endpoint returned ${res.status}`);
  const data = await res.json();
  const injured = Array.isArray(data) ? data : (data.injured || []);
  // Clear all injury columns — if fetch failed we threw above, so we never reach here on error
  await db.prepare(`UPDATE nhl_players SET injury_status = '', injury_description = ''`).run();
  // Write injured players in D1 batches of 100
  for (let i = 0; i < injured.length; i += 100) {
    const batch = injured.slice(i, i + 100);
    await db.batch(batch.map(p => {
      const playerId = p.playerId || p.id;
      const status = p.status || '';
      const description = p.injuryDescription || p.longTermInjuryNote || p.description || '';
      return db.prepare(
        `UPDATE nhl_players SET injury_status = ?, injury_description = ? WHERE player_id = ?`
      ).bind(status, description, playerId);
    }));
  }
  console.log(`[cron] syncInjuries: ${injured.length} injured players written`);
  return injured.length;
}
```

- [ ] **Step 2: Add `refreshRosteredPlayerLandings(db)` function**

Add immediately after `syncInjuries`:

```js
async function refreshRosteredPlayerLandings(db) {
  const { results } = await db
    .prepare('SELECT DISTINCT player_id FROM team_players')
    .all();
  const playerIds = (results || []).map(r => r.player_id);
  if (!playerIds.length) return;
  const now = new Date().toISOString();
  // Process in batches of 20 concurrent fetches
  for (let i = 0; i < playerIds.length; i += 20) {
    const batch = playerIds.slice(i, i + 20);
    await Promise.allSettled(batch.map(async (playerId) => {
      try {
        const res = await fetch(`${NHL_BASE}/player/${playerId}/landing`, {
          headers: { 'User-Agent': 'PlayoffFantasy/1.0 (Cloudflare Worker)' }
        });
        if (!res.ok) return;
        const data = await res.json();
        await savePlayerLandingSnapshot(db, playerId, data, now);
      } catch (err) {
        console.error(`[cron] landing refresh failed for player ${playerId}:`, err?.message);
      }
    }));
  }
  console.log(`[cron] refreshRosteredPlayerLandings: refreshed ${playerIds.length} players`);
}
```

- [ ] **Step 3: Wire both functions into the scheduled handler**

Find the scheduled handler. After the existing `syncNhlRosters` try/catch block (~line 3596), but before the final `computeStandings` try/catch, add:

```js
    // Sync player injury status from NHL injury endpoint
    try {
      await syncInjuries(db);
    } catch (err) {
      console.error('[cron] syncInjuries failed:', err?.message ?? err);
    }

    // Refresh landing snapshots for all rostered players
    try {
      await refreshRosteredPlayerLandings(db);
    } catch (err) {
      console.error('[cron] refreshRosteredPlayerLandings failed:', err?.message ?? err);
    }
```

The full cron order should be:
1. Per-league standings / matchups / waivers / trades / draft / auction stalls (existing loop)
2. `syncNhlRosters(db)` (existing)
3. `syncInjuries(db)` ← NEW
4. `refreshRosteredPlayerLandings(db)` ← NEW
5. Global legacy `computeStandings` (existing)

- [ ] **Step 4: Syntax check**

```bash
node --check worker/index.js
```
Expected: no output (no syntax errors)

- [ ] **Step 5: Commit**

```bash
git add worker/index.js
git commit -m "feat: add syncInjuries and refreshRosteredPlayerLandings cron functions"
```

---

### Task 3: Worker Routes — inject injury + landing data

**Files:**
- Modify: `worker/index.js`

**Context — key line numbers (verify before editing; lines shift as you add code):**
- `lineupMatch GET` handler: `pathname.match(/^\/api\/leagues\/(\d+)\/teams\/(\d+)\/lineup\/(\d+)$/)` at ~line 1052; the GET branch returns at ~line 1094
- `lgPlayersMatch GET` handler: `pathname.match(/^\/api\/leagues\/(\d+)\/teams\/(\d+)\/players$/)` at ~line 2536; returns `json(await getTeamPlayers(db, teamId))` at ~line 2542
- `waiversListMatch GET` handler: `pathname.match(/^\/api\/leagues\/(\d+)\/waivers$/)` at ~line 2163; query at ~line 2169
- `explorerMatch GET` handler: `pathname.match(/^\/api\/leagues\/(\d+)\/players$/)` at ~line 2756; returns json at ~line 2784
- `playerDetailMatch GET` handler: `pathname.match(/^\/api\/leagues\/(\d+)\/players\/(\d+)$/)` at ~line 2787; returns json at ~line 2841

**Interfaces:**
- Consumes: `getTeamPlayers(db, teamId)`, `loadLeagueContext`, `parseId`, `json`, `computeStandings`, `parseLandingSnapshot`
- Produces: All player list routes now include `injuryStatus: string` and `injuryDescription: string` on every player object. `playerDetailMatch GET` additionally returns `featuredStats`, `gameLog`, `spotlightStories`.

- [ ] **Step 1: Add `getInjuryMap` helper**

Add this function just after `getPlayerLandingSnapshotMap` (~line 510):

```js
async function getInjuryMap(db, playerIds) {
  if (!playerIds || !playerIds.length) return {};
  const placeholders = playerIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT player_id, injury_status, injury_description
       FROM nhl_players WHERE player_id IN (${placeholders})`
    )
    .bind(...playerIds)
    .all();
  const map = {};
  for (const r of (results || [])) {
    map[r.player_id] = {
      injuryStatus: r.injury_status || '',
      injuryDescription: r.injury_description || '',
    };
  }
  return map;
}
```

- [ ] **Step 2: Update `lgPlayersMatch GET` to include injury fields**

Find the handler for `lgPlayersMatch && request.method === 'GET'` (~line 2537). It currently reads:
```js
return json(await getTeamPlayers(db, teamId));
```

Replace just that return line with:
```js
const players = await getTeamPlayers(db, teamId);
const injuryMap = await getInjuryMap(db, players.map(p => p.player_id));
return json(players.map(p => ({
  ...p,
  injuryStatus: injuryMap[p.player_id]?.injuryStatus || '',
  injuryDescription: injuryMap[p.player_id]?.injuryDescription || '',
})));
```

- [ ] **Step 3: Update `lineupMatch GET` to include injury fields**

Find the `lineupMatch && request.method === 'GET'` block. Near the end (~line 1092), it currently reads:
```js
const active = players.filter(p => activeMap.get(p.player_id));
const bench  = players.filter(p => !activeMap.get(p.player_id));
return json({ active, bench, slots, locked });
```

Replace those 3 lines with:
```js
const active = players.filter(p => activeMap.get(p.player_id));
const bench  = players.filter(p => !activeMap.get(p.player_id));
const injuryMap = await getInjuryMap(db, players.map(p => p.player_id));
const addInjury = p => ({
  ...p,
  injuryStatus: injuryMap[p.player_id]?.injuryStatus || '',
  injuryDescription: injuryMap[p.player_id]?.injuryDescription || '',
});
return json({ active: active.map(addInjury), bench: bench.map(addInjury), slots, locked });
```

- [ ] **Step 4: Update `waiversListMatch GET` to include injury fields**

Find the handler for `waiversListMatch && request.method === 'GET'` (~line 2163). It currently has a query:
```js
const { results: players } = await db.prepare(`
  SELECT dp.*, t.name AS dropped_by_team_name
  FROM dropped_players dp
  JOIN teams t ON t.id = dp.dropped_by_team_id
  WHERE dp.league_id = ? AND dp.status IN ('waivers', 'free_agent')
  ORDER BY dp.dropped_at DESC
`).bind(leagueId).all();
```

Replace the SQL string only (keep the variable name and `.bind(leagueId).all()`) to add the LEFT JOIN:
```js
const { results: players } = await db.prepare(`
  SELECT dp.*, t.name AS dropped_by_team_name,
         COALESCE(np.injury_status, '') AS injury_status,
         COALESCE(np.injury_description, '') AS injury_description
  FROM dropped_players dp
  JOIN teams t ON t.id = dp.dropped_by_team_id
  LEFT JOIN nhl_players np ON np.player_id = dp.player_id
  WHERE dp.league_id = ? AND dp.status IN ('waivers', 'free_agent')
  ORDER BY dp.dropped_at DESC
`).bind(leagueId).all();
```

Then update the return statement (currently `return json({ players: players || [], myClaims });`) to map the snake_case columns to camelCase:
```js
const mappedPlayers = (players || []).map(p => ({
  ...p,
  injuryStatus: p.injury_status || '',
  injuryDescription: p.injury_description || '',
}));
return json({ players: mappedPlayers, myClaims });
```

- [ ] **Step 5: Update `explorerMatch GET` to include injury fields**

Find the handler for `explorerMatch && request.method === 'GET'` (~line 2756). At the end, just before `return json(...)`, the code builds a `players` array. Add injury merging:

Find these lines near the end of the handler:
```js
const players = [...map.values()]
  .map((p) => ({ ...p, ownerCount: p.owners.length, ownershipPct: totalTeams ? Math.round((p.owners.length / totalTeams) * 100) : 0 }))
  .sort((a, b) => (b.points || 0) - (a.points || 0));
return json({ players, totalTeams, season: standings.season });
```

Replace with:
```js
const playerIdList = [...map.keys()];
const injuryMap = await getInjuryMap(db, playerIdList);
const players = [...map.values()]
  .map((p) => ({
    ...p,
    ownerCount: p.owners.length,
    ownershipPct: totalTeams ? Math.round((p.owners.length / totalTeams) * 100) : 0,
    injuryStatus: injuryMap[p.playerId]?.injuryStatus || '',
    injuryDescription: injuryMap[p.playerId]?.injuryDescription || '',
  }))
  .sort((a, b) => (b.points || 0) - (a.points || 0));
return json({ players, totalTeams, season: standings.season });
```

Note: the key in `map` is `player_id` (integer) from `p.player_id`, so `injuryMap[p.playerId]` — confirm the key type matches. In `getInjuryMap`, keys are stored as `r.player_id` (integer from D1). The map keys set here are `p.player_id` from team players. Both should be integers. Double-check there's no string/integer mismatch.

- [ ] **Step 6: Update `playerDetailMatch GET` to add injury + landing data**

Find the handler for `playerDetailMatch && request.method === 'GET'` (~line 2787). The handler currently ends with:
```js
const eliminated = elimSet.has((player.nhl_team || '').trim().toUpperCase());
return json({
  player, stats, points, breakdown, partial,
  owners, ownerCount: owners.length,
  ownershipPct: totalTeams ? Math.round((owners.length / totalTeams) * 100) : 0,
  totalTeams, eliminated, season,
});
```

Replace these last two statements with:
```js
const eliminated = elimSet.has((player.nhl_team || '').trim().toUpperCase());

// Fetch injury + landing data in parallel
const [nhlRow, landingSnap] = await Promise.all([
  db.prepare('SELECT injury_status, injury_description FROM nhl_players WHERE player_id = ?')
    .bind(playerId).first(),
  db.prepare('SELECT landing_json FROM player_landing_snapshots WHERE player_id = ?')
    .bind(playerId).first(),
]);
const injuryStatus = nhlRow?.injury_status || '';
const injuryDescription = nhlRow?.injury_description || '';

let featuredStats = null, gameLog = null, spotlightStories = null;
if (landingSnap?.landing_json) {
  try {
    const landing = JSON.parse(landingSnap.landing_json);
    featuredStats = landing.featuredStats || null;
    gameLog = (landing.gameLog || []).slice(0, 5);
    spotlightStories = landing.spotlightStories || null;
  } catch {}
}

return json({
  player: { ...player, injuryStatus, injuryDescription },
  stats, points, breakdown, partial,
  owners, ownerCount: owners.length,
  ownershipPct: totalTeams ? Math.round((owners.length / totalTeams) * 100) : 0,
  totalTeams, eliminated, season,
  injuryStatus, injuryDescription,
  featuredStats, gameLog, spotlightStories,
});
```

- [ ] **Step 7: Add `GET /api/leagues/:id/injuries` endpoint**

Find the `explorerMatch` variable definition (~line 2756). Add the new route BEFORE it:

```js
  const leagueInjuriesMatch = pathname.match(/^\/api\/leagues\/(\d+)\/injuries$/);
  if (leagueInjuriesMatch && request.method === 'GET') {
    const leagueId = parseId(leagueInjuriesMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    const { results } = await db
      .prepare(`SELECT player_id, injury_status, injury_description FROM nhl_players WHERE injury_status != ''`)
      .all();
    const injuries = {};
    for (const r of (results || [])) {
      injuries[r.player_id] = {
        injuryStatus: r.injury_status,
        injuryDescription: r.injury_description,
      };
    }
    return json({ injuries });
  }
```

- [ ] **Step 8: Syntax check**

```bash
node --check worker/index.js
```
Expected: no output

- [ ] **Step 9: Commit**

```bash
git add worker/index.js
git commit -m "feat: inject injury status into player-list routes and add injuries endpoint"
```

---

### Task 4: PlayerStatusBadge Component + CSS

**Files:**
- Create: `client/src/components/PlayerStatusBadge.jsx`
- Modify: `client/src/App.css`

**Interfaces:**
- Consumes: `injuryStatus: string`, `injuryDescription: string` as props
- Produces: `<PlayerStatusBadge injuryStatus={...} injuryDescription={...} />` — renders nothing when `injuryStatus` is empty string

- [ ] **Step 1: Create the component**

```jsx
// client/src/components/PlayerStatusBadge.jsx
const STATUS_COLORS = {
  IR:   '#ef4444',
  LTIR: '#ef4444',
  OUT:  '#991b1b',
  DTD:  '#f97316',
};

export default function PlayerStatusBadge({ injuryStatus, injuryDescription }) {
  if (!injuryStatus) return null;
  const bg = STATUS_COLORS[injuryStatus] || '#6b7280';
  return (
    <span
      className="player-status-badge"
      style={{ backgroundColor: bg }}
      title={injuryDescription || injuryStatus}
    >
      {injuryStatus}
    </span>
  );
}
```

- [ ] **Step 2: Add CSS to `client/src/App.css`**

Find the `.player-pos-badge` block (~line 498). Add the new rule immediately after the existing `.player-pos-badge` rules:

```css
.player-status-badge {
  display: inline-block;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.04em;
  vertical-align: middle;
  margin-left: 4px;
  white-space: nowrap;
}
```

- [ ] **Step 3: Visual sanity check**

No automated test — the component will be exercised when the pages are updated in Task 5. Proceed.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/PlayerStatusBadge.jsx client/src/App.css
git commit -m "feat: add PlayerStatusBadge component and badge CSS"
```

---

### Task 5: Update All 7 Player-List Pages

**Files:**
- Modify: `client/src/pages/TeamDetail.jsx`
- Modify: `client/src/pages/LineupPage.jsx`
- Modify: `client/src/pages/WaiverWirePage.jsx`
- Modify: `client/src/pages/AddPlayers.jsx`
- Modify: `client/src/pages/PlayerExplorer.jsx`
- Modify: `client/src/pages/DraftPage.jsx`
- Modify: `client/src/pages/AuctionPage.jsx`

**Interfaces:**
- Consumes: `PlayerStatusBadge` from `../components/PlayerStatusBadge.jsx`
- Consumes: `Link` from `react-router-dom` (already imported in most pages — verify before adding)
- Consumes: `api.leagues.injuries(leagueId)` → `{ injuries: { [player_id]: { injuryStatus, injuryDescription } } }` (only for DraftPage and AuctionPage)

**How injury data flows per page:**
- `TeamDetail`: players come from `api.leagues.getStandings` (standings data, no injury). Fix: parallel-fetch `api.leagues.getPlayers(leagueId, teamId)` and build an injuryMap. Use `player.player_id` as the key.
- `LineupPage`: lineup data from `api.leagues.lineup.get` now includes injury fields (Task 3). Use directly.
- `WaiverWirePage`: waiver players from `api.leagues.waivers.list` now include `injuryStatus`/`injuryDescription` (Task 3). Use directly.
- `AddPlayers`: roster from `api.leagues.getPlayers` now includes injury fields (Task 3). Use directly.
- `PlayerExplorer`: explorer data from `api.leagues.explorer` now includes `injuryStatus`/`injuryDescription` (Task 3). Use directly on the `PlayerDetail` panel.
- `DraftPage` / `AuctionPage`: player pool from Durable Object via WebSocket; use `api.leagues.injuries(leagueId)` to fetch separate injuryMap.

---

#### 5a: TeamDetail.jsx

- [ ] **Step 1: Import `PlayerStatusBadge` and `Link`**

`Link` is already imported (`import { useParams, useNavigate, useOutletContext, Link } from 'react-router-dom'`). Add `PlayerStatusBadge`:

```js
import PlayerStatusBadge from '../components/PlayerStatusBadge.jsx'
```

- [ ] **Step 2: Add `injuryMap` state and parallel-fetch**

In the `TeamDetail` component function, add:
```js
const [injuryMap, setInjuryMap] = useState({})
```

In `fetchTeam` (the existing `useCallback`), update the `Promise.all` to also fetch injury data. Currently it only fetches `api.leagues.getStandings`. Find `fetchTeam` and update it:

```js
const fetchTeam = useCallback(async () => {
  setLoading(true)
  try {
    const [standingsData, injuredPlayers] = await Promise.all([
      api.leagues.getStandings(leagueId),
      api.leagues.getPlayers(leagueId, teamId),
    ])
    const found = standingsData.standings?.find((t) => t.id === parseInt(teamId))
    if (found) {
      setTeamData({ team: found, poolGoalieCount: standingsData.poolGoalieCount })
      setEliminatedTeams(standingsData.eliminatedTeams || [])
    } else {
      setError('Team not found')
    }
    const map = {}
    for (const p of (injuredPlayers || [])) {
      map[p.player_id] = { injuryStatus: p.injuryStatus || '', injuryDescription: p.injuryDescription || '' }
    }
    setInjuryMap(map)
  } catch (err) {
    setError(err.message)
  } finally {
    setLoading(false)
  }
}, [leagueId, teamId])
```

- [ ] **Step 3: Pass injury data to `PlayerRow` and add link**

`PlayerRow` is defined in the same file. It currently renders `<div className="player-name">{player.player_name}</div>`.

Add `leagueId`, `injuryStatus`, and `injuryDescription` props to `PlayerRow`. Update the function signature:
```js
function PlayerRow({ player, onRemove, eliminated, canEdit, leagueId, injuryStatus, injuryDescription }) {
```

Replace the player name line:
```jsx
<div className="player-name">
  <Link to={`/leagues/${leagueId}/players/${player.player_id}`}>{player.player_name}</Link>
  <PlayerStatusBadge injuryStatus={injuryStatus} injuryDescription={injuryDescription} />
</div>
```

- [ ] **Step 4: Update `PlayerRow` usage sites**

Find where `<PlayerRow` is used in the JSX (within the forwards/defensemen/goalies render loops). Add the new props:
```jsx
<PlayerRow
  key={p.id}
  player={p}
  onRemove={handleRemovePlayer}
  eliminated={isEliminated}
  canEdit={canEdit}
  leagueId={leagueId}
  injuryStatus={injuryMap[p.player_id]?.injuryStatus || ''}
  injuryDescription={injuryMap[p.player_id]?.injuryDescription || ''}
/>
```

- [ ] **Step 5: Verify no duplicate `Link` import**

Ensure `Link` is imported only once.

---

#### 5b: LineupPage.jsx

- [ ] **Step 1: Import `PlayerStatusBadge` and `Link`**

`Link` is already imported in `LineupPage`. Add:
```js
import PlayerStatusBadge from '../components/PlayerStatusBadge.jsx'
```

- [ ] **Step 2: Find player name render and add badge + link**

In `LineupPage`, find where player names are rendered in the lineup slots. The component renders `active` and `bench` arrays. Find the player name display and update it. Typical pattern:
```jsx
<Link to={`/leagues/${leagueId}/players/${p.player_id}`}>{p.player_name}</Link>
<PlayerStatusBadge injuryStatus={p.injuryStatus || ''} injuryDescription={p.injuryDescription || ''} />
```

---

#### 5c: WaiverWirePage.jsx

- [ ] **Step 1: Import `PlayerStatusBadge` and `Link`**

`Link` is NOT currently imported in WaiverWirePage. Add both:
```js
import { Link } from 'react-router-dom'
import PlayerStatusBadge from '../components/PlayerStatusBadge.jsx'
```

- [ ] **Step 2: Find player name renders and update**

The page shows dropped players. Find where `p.player_name` is rendered in the players list. Add badge and link:
```jsx
<Link to={`/leagues/${leagueId}/players/${p.player_id}`}>{p.player_name}</Link>
<PlayerStatusBadge injuryStatus={p.injuryStatus || ''} injuryDescription={p.injuryDescription || ''} />
```

The waiver claim modal also shows `claimTarget.player_name` — no need to linkify that (it's inside a modal). Add the badge only there if desired:
```jsx
<PlayerStatusBadge injuryStatus={claimTarget.injuryStatus || ''} injuryDescription={claimTarget.injuryDescription || ''} />
```

---

#### 5d: AddPlayers.jsx

- [ ] **Step 1: Import `PlayerStatusBadge` and `Link`**

`Link` is already imported. Add:
```js
import PlayerStatusBadge from '../components/PlayerStatusBadge.jsx'
```

- [ ] **Step 2: Find roster player name render and update**

The page shows the current roster below the search area. Find where roster player names are rendered and add badge + link. The roster players are in the `roster` state array (returned from `api.leagues.getPlayers`), which now includes `injuryStatus` and `injuryDescription`:
```jsx
<Link to={`/leagues/${leagueId}/players/${p.player_id}`}>{p.player_name}</Link>
<PlayerStatusBadge injuryStatus={p.injuryStatus || ''} injuryDescription={p.injuryDescription || ''} />
```

---

#### 5e: PlayerExplorer.jsx

- [ ] **Step 1: Import `PlayerStatusBadge`**

`Link` is already imported. Add:
```js
import PlayerStatusBadge from '../components/PlayerStatusBadge.jsx'
```

- [ ] **Step 2: Add badge to `PlayerDetail` panel and make name a link**

The `PlayerDetail` component (internal to `PlayerExplorer.jsx`) renders the detail panel for a clicked player. It has an `explorer-name` div. Update it:
```jsx
<div className="explorer-name">
  <Link to={`/leagues/${leagueId}/players/${detail.player.playerId}`}>{detail.player.name}</Link>
  <PlayerStatusBadge injuryStatus={detail.player.injuryStatus || ''} injuryDescription={detail.player.injuryDescription || ''} />
</div>
```

Also update the player list rows (the search results / rostered players list) to show a badge next to each player name.

Note: `PlayerDetail` is called with `<PlayerDetail leagueId={leagueId} detail={detail} />` — `leagueId` is already passed. Confirm this in the JSX and that `detail.player.playerId` is the correct field name (check the `explorerMatch GET` response — the player objects there have `playerId` from `p.player_id`).

---

#### 5f: DraftPage.jsx

- [ ] **Step 1: Import `PlayerStatusBadge`**

```js
import PlayerStatusBadge from '../components/PlayerStatusBadge.jsx'
```

- [ ] **Step 2: Add `injuryMap` state and fetch on mount**

At the top of the `DraftPage` component (or wherever `leagueId` is available), add:
```js
const [injuryMap, setInjuryMap] = useState({})
```

In the existing `useEffect` that loads draft session data (around where `api.leagues.draft.getSession` is called), add a parallel fetch:
```js
api.leagues.injuries(leagueId)
  .then(d => setInjuryMap(d.injuries || {}))
  .catch(() => {}) // non-fatal — badges just won't show
```

- [ ] **Step 3: Add badge to player pool rows**

Find where player pool rows are rendered (`filtered.map(p => ...)`). The player objects have `playerId` (set from `player_id` in rankings). Add badge after the player name:
```jsx
<PlayerStatusBadge
  injuryStatus={injuryMap[p.playerId]?.injuryStatus || ''}
  injuryDescription={injuryMap[p.playerId]?.injuryDescription || ''}
/>
```

Note: `injuryMap` keys are integers from D1 (`player_id`). `p.playerId` may be an integer or string depending on how the DO stores it. Use `injuryMap[parseInt(p.playerId)]` if needed.

---

#### 5g: AuctionPage.jsx

- [ ] **Step 1: Import `PlayerStatusBadge`**

```js
import PlayerStatusBadge from '../components/PlayerStatusBadge.jsx'
```

- [ ] **Step 2: Add `injuryMap` state and fetch on mount**

Same pattern as DraftPage: add `injuryMap` state and fetch `api.leagues.injuries(leagueId)` in the existing mount effect.

- [ ] **Step 3: Add badge to player pool rows**

Find where auction player pool rows render. Add badge after player name:
```jsx
<PlayerStatusBadge
  injuryStatus={injuryMap[parseInt(p.playerId)]?.injuryStatus || ''}
  injuryDescription={injuryMap[parseInt(p.playerId)]?.injuryDescription || ''}
/>
```

- [ ] **Step 4: Commit all page updates**

```bash
git add client/src/pages/TeamDetail.jsx client/src/pages/LineupPage.jsx \
        client/src/pages/WaiverWirePage.jsx client/src/pages/AddPlayers.jsx \
        client/src/pages/PlayerExplorer.jsx client/src/pages/DraftPage.jsx \
        client/src/pages/AuctionPage.jsx
git commit -m "feat: add PlayerStatusBadge and player detail links to all player-list pages"
```

---

### Task 6: PlayerDetailPage + api.js + App.jsx Route

**Files:**
- Create: `client/src/pages/PlayerDetailPage.jsx`
- Modify: `client/src/api.js`
- Modify: `client/src/App.jsx`

**Context:**
- `api.leagues.player(leagueId, playerId)` already exists in `api.js` (line 127) — NO need to add a new method for the detail fetch
- `api.leagues.injuries` is NOT yet in `api.js` — add it here
- `teamCrestUrl` is worker-side only; on the client, `player.crest_url` in the response already contains the computed crest URL
- The route is nested under `/leagues/:leagueId` in `LeagueLayout`, so `useOutletContext()` gives `{ league }` and `useParams()` gives `{ leagueId, playerId }`

**Interfaces:**
- Consumes: `api.leagues.player(leagueId, playerId)` → response shape documented in Task 3 step 6
- Produces: `<PlayerDetailPage />` React component at route `/leagues/:leagueId/players/:playerId`

- [ ] **Step 1: Add `injuries` method to `api.js`**

In `client/src/api.js`, find the `leagues` object. Add after `player: (id, playerId) => ...`:
```js
injuries: (id) => request(`/api/leagues/${id}/injuries`),
```

- [ ] **Step 2: Add `players/:playerId` route to `App.jsx`**

In `client/src/App.jsx`, add the import:
```js
import PlayerDetailPage from './pages/PlayerDetailPage.jsx'
```

Inside the `<Route path="/leagues/:leagueId" element={<LeagueLayout />}>` block, add:
```jsx
<Route path="players/:playerId" element={<PlayerDetailPage />} />
```

Note: the existing `<Route path="players" element={<PlayerExplorer />} />` stays unchanged — React Router matches `players` (no param) vs `players/:playerId` (with param) correctly.

- [ ] **Step 3: Create `PlayerDetailPage.jsx`**

```jsx
// client/src/pages/PlayerDetailPage.jsx
import { useState, useEffect } from 'react'
import { useParams, useOutletContext, Link } from 'react-router-dom'
import { api } from '../api.js'
import PlayerStatusBadge from '../components/PlayerStatusBadge.jsx'

function StatGrid({ position, featuredStats }) {
  const sub = featuredStats?.regularSeason?.subSeason
  if (!sub) return null
  const isGoalie = position === 'G'
  return (
    <div className="player-detail-stat-grid">
      <div className="stat-chip"><div className="stat-chip-value">{sub.gamesPlayed ?? '–'}</div><div className="stat-chip-label">GP</div></div>
      {isGoalie ? (
        <>
          <div className="stat-chip"><div className="stat-chip-value">{sub.wins ?? '–'}</div><div className="stat-chip-label">W</div></div>
          <div className="stat-chip"><div className="stat-chip-value">{sub.losses ?? '–'}</div><div className="stat-chip-label">L</div></div>
          <div className="stat-chip"><div className="stat-chip-value">{sub.goalsAgainstAverage?.toFixed(2) ?? '–'}</div><div className="stat-chip-label">GAA</div></div>
          <div className="stat-chip"><div className="stat-chip-value">{sub.savePctg ? sub.savePctg.toFixed(3) : '–'}</div><div className="stat-chip-label">SV%</div></div>
        </>
      ) : (
        <>
          <div className="stat-chip"><div className="stat-chip-value">{sub.goals ?? '–'}</div><div className="stat-chip-label">G</div></div>
          <div className="stat-chip"><div className="stat-chip-value">{sub.assists ?? '–'}</div><div className="stat-chip-label">A</div></div>
          <div className="stat-chip"><div className="stat-chip-value">{sub.points ?? '–'}</div><div className="stat-chip-label">PTS</div></div>
          <div className="stat-chip">
            <div className={`stat-chip-value ${(sub.plusMinus ?? 0) > 0 ? 'pm-positive' : (sub.plusMinus ?? 0) < 0 ? 'pm-negative' : ''}`}>
              {(sub.plusMinus ?? 0) > 0 ? '+' : ''}{sub.plusMinus ?? '–'}
            </div>
            <div className="stat-chip-label">+/-</div>
          </div>
        </>
      )}
    </div>
  )
}

function GameLogTable({ position, gameLog }) {
  if (!gameLog || !gameLog.length) return null
  const isGoalie = position === 'G'
  return (
    <div className="player-detail-section">
      <h3 className="player-detail-section-title">Recent Games</h3>
      <table className="player-detail-gamelog">
        <thead>
          <tr>
            <th>Date</th>
            <th>Opp</th>
            <th>H/A</th>
            {isGoalie ? (
              <>
                <th>Dec</th>
                <th>GAA</th>
                <th>SV%</th>
              </>
            ) : (
              <>
                <th>G</th>
                <th>A</th>
                <th>PTS</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {gameLog.map((g, i) => (
            <tr key={i}>
              <td>{g.gameDate || '–'}</td>
              <td>{g.opponentAbbrev || '–'}</td>
              <td>{g.homeRoadFlag || '–'}</td>
              {isGoalie ? (
                <>
                  <td>{g.decision || '–'}</td>
                  <td>{g.goalsAgainstAverage?.toFixed(2) ?? '–'}</td>
                  <td>{g.savePctg ? g.savePctg.toFixed(3) : '–'}</td>
                </>
              ) : (
                <>
                  <td>{g.goals ?? '–'}</td>
                  <td>{g.assists ?? '–'}</td>
                  <td>{g.points ?? '–'}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function NewsStories({ spotlightStories }) {
  if (!spotlightStories || !spotlightStories.length) return null
  return (
    <div className="player-detail-section">
      <h3 className="player-detail-section-title">News</h3>
      <div className="player-detail-news">
        {spotlightStories.map((s, i) => (
          <div key={i} className="player-detail-news-card">
            <div className="player-detail-news-title">{s.title}</div>
            <div className="player-detail-news-meta">
              {s.contributor && <span>{s.contributor}</span>}
              {s.date && <span> · {s.date}</span>}
            </div>
            {s.description && <div className="player-detail-news-body">{s.description}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function PlayerDetailPage() {
  const { leagueId, playerId } = useParams()
  const { league } = useOutletContext()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [imgFailed, setImgFailed] = useState(false)

  useEffect(() => {
    setLoading(true)
    setError('')
    api.leagues.player(leagueId, playerId)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [leagueId, playerId])

  if (loading) return <div className="loading-state"><span className="loading-spinner" /> Loading player…</div>
  if (error) return (
    <div>
      <Link to={`/leagues/${leagueId}/players`} className="back-link">← Players</Link>
      <div className="alert alert-error">{error}</div>
    </div>
  )
  if (!data) return null

  const { player, injuryStatus, injuryDescription, featuredStats, gameLog, spotlightStories } = data
  const hasLandingData = featuredStats || (gameLog && gameLog.length) || (spotlightStories && spotlightStories.length)

  return (
    <div className="player-detail-page">
      <Link to={`/leagues/${leagueId}/players`} className="back-link">← Players</Link>

      {/* Header */}
      <div className="player-detail-header card">
        {player.crest_url && <img src={player.crest_url} alt="" className="player-detail-crest" aria-hidden="true" />}
        {player.headshot_url && !imgFailed
          ? <img src={player.headshot_url} alt="" className="player-detail-headshot" onError={() => setImgFailed(true)} />
          : <div className="player-detail-headshot player-headshot-placeholder">{player.position}</div>}
        <div className="player-detail-info">
          <div className="player-detail-name">
            {player.name}
            <PlayerStatusBadge injuryStatus={injuryStatus} injuryDescription={injuryDescription} />
          </div>
          <div className="player-meta">
            {player.nhl_team && <span className="player-team-badge">{player.nhl_team}</span>}
            <span className={`player-pos-badge ${(player.position || '').toLowerCase()}`}>
              {player.position_detail || player.position}
            </span>
          </div>
        </div>
      </div>

      {/* Injury banner */}
      {injuryStatus && (
        <div className="player-detail-injury-banner alert alert-error">
          <strong>{injuryStatus}</strong>{injuryDescription ? `: ${injuryDescription}` : ''}
        </div>
      )}

      {hasLandingData ? (
        <>
          {/* Stats grid */}
          {featuredStats && (
            <div className="player-detail-section">
              <h3 className="player-detail-section-title">Current Season Stats</h3>
              <StatGrid position={player.position} featuredStats={featuredStats} />
            </div>
          )}

          {/* Game log */}
          <GameLogTable position={player.position} gameLog={gameLog} />

          {/* News */}
          <NewsStories spotlightStories={spotlightStories} />
        </>
      ) : (
        <div className="empty-state-inline" style={{ marginTop: 24 }}>
          No additional player data available yet — check back after the next cron refresh.
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Add CSS for the detail page to `App.css`**

Append to `client/src/App.css`:

```css
/* ── Player Detail Page ─────────────────────────── */
.player-detail-page { max-width: 680px; margin: 0 auto; padding: 0 0 48px; }

.player-detail-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px;
  position: relative;
  overflow: hidden;
  margin: 12px 0;
}
.player-detail-crest {
  position: absolute; right: 12px; top: 12px;
  width: 52px; height: 52px; opacity: 0.12; pointer-events: none;
}
.player-detail-headshot {
  width: 72px; height: 72px; border-radius: 50%;
  object-fit: cover; border: 2px solid var(--border);
  flex-shrink: 0;
}
.player-detail-name {
  font-size: 1.3rem; font-weight: 700; color: var(--text);
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
}
.player-detail-injury-banner {
  margin: 0 0 12px;
}
.player-detail-section { margin-top: 20px; }
.player-detail-section-title {
  font-size: 0.75rem; font-weight: 600; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--text-muted);
  margin: 0 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--border);
}
.player-detail-stat-grid {
  display: flex; gap: 8px; flex-wrap: wrap;
}
.player-detail-gamelog {
  width: 100%; border-collapse: collapse; font-size: 0.875rem;
}
.player-detail-gamelog th, .player-detail-gamelog td {
  padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border);
}
.player-detail-gamelog th { color: var(--text-muted); font-weight: 600; font-size: 0.75rem; }
.player-detail-gamelog tr:last-child td { border-bottom: none; }
.player-detail-news { display: flex; flex-direction: column; gap: 12px; }
.player-detail-news-card {
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: 8px; padding: 14px 16px;
}
.player-detail-news-title { font-weight: 600; color: var(--text); margin-bottom: 4px; }
.player-detail-news-meta { font-size: 0.8rem; color: var(--text-muted); margin-bottom: 6px; }
.player-detail-news-body { font-size: 0.875rem; color: var(--text-dim); line-height: 1.5; }
```

- [ ] **Step 5: Build check**

```bash
npm run build --prefix client
```
Expected: Build succeeds with no errors (warnings about bundle size are acceptable).

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/PlayerDetailPage.jsx client/src/api.js client/src/App.jsx client/src/App.css
git commit -m "feat: add PlayerDetailPage with injury, stats, recent games, and news"
```

---

## Self-Review

### Spec Coverage

| Spec Requirement | Covered By |
|-----------------|-----------|
| `injury_status` + `injury_description` columns in `nhl_players` | Task 1 |
| `syncInjuries(db)` — fetch, clear, write | Task 2 |
| `refreshRosteredPlayerLandings(db)` — batch of 20, allSettled | Task 2 |
| Cron order: syncNhlRosters → syncInjuries → refreshLandings | Task 2 |
| Injury endpoint down → leave existing values | Task 2 (throw before clear) |
| Landing fail → allSettled, keep existing snapshot | Task 2 |
| `lgPlayersMatch GET` injury fields | Task 3 |
| `lineupMatch GET` injury fields | Task 3 |
| `waiversListMatch GET` injury fields | Task 3 |
| `explorerMatch GET` injury fields | Task 3 |
| `playerDetailMatch GET` injury + landing data | Task 3 |
| `GET /api/leagues/:id/injuries` endpoint | Task 3 |
| `PlayerStatusBadge` component (colors, title hover) | Task 4 |
| Badge on TeamDetail | Task 5a |
| Badge on LineupPage | Task 5b |
| Badge on WaiverWirePage | Task 5c |
| Badge on AddPlayers | Task 5d |
| Badge on PlayerExplorer | Task 5e |
| Badge on DraftPage | Task 5f |
| Badge on AuctionPage | Task 5g |
| `PlayerDetailPage` with bio, injury banner, stats, game log, news | Task 6 |
| Fallback when no landing snapshot | Task 6 (`hasLandingData` check) |
| App.jsx route `players/:playerId` | Task 6 |
| `api.leagues.injuries(id)` | Task 6 |

### Placeholder Scan

No TBDs, TODOs, or "handle edge cases" vague instructions found. All code blocks are complete and runnable.

### Type Consistency

- `injuryStatus` / `injuryDescription` (camelCase) used consistently on the client. The D1 columns are `injury_status` / `injury_description` (snake_case). All mappings at Task 3 go from snake_case to camelCase — confirmed.
- `player_id` (integer) used as the map key throughout. For DraftPage/AuctionPage, `parseInt(p.playerId)` handles potential string-to-integer mismatch.
- `api.leagues.player(leagueId, playerId)` is the existing method name — used correctly in Task 6 (`PlayerDetailPage`).
- `api.leagues.injuries(leagueId)` added in Task 6, consumed in Tasks 5f and 5g.
