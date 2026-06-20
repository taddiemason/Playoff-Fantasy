# Player News & Injury Status Design

**Date:** 2026-06-20
**Status:** Approved

## Overview

Surface NHL player injury status as an inline badge on every player row across the app, and provide a player detail page showing current season stats, recent game log, and NHL.com news blurbs. All data sourced from the NHL Web API (`api-web.nhle.com`) — no third-party services required.

---

## Architecture

### Data Sources

| Data | Endpoint | Cadence |
|------|----------|---------|
| Injury status | `GET /v1/injury` | Hourly cron |
| Player bio + stats + news | `GET /v1/player/{id}/landing` | Hourly cron (rostered players only) |

Both are appended to the existing hourly `scheduled` cron handler after `syncNhlRosters()`.

### Two new cron tasks

**`syncInjuries(db)`**
1. Fetch `https://api-web.nhle.com/v1/injury`
2. Clear `injury_status` and `injury_description` on all `nhl_players` rows
3. Write status + description for each returned injured player

**`refreshRosteredPlayerLandings(db)`**
1. Query all distinct `player_id` values from `team_players` (across all leagues)
2. Fetch `/v1/player/{id}/landing` in batches of 20 with `Promise.allSettled`
3. Upsert each result into `player_landing_snapshots`

---

## Data Model

### Migration 0018

```sql
ALTER TABLE nhl_players ADD COLUMN injury_status      TEXT NOT NULL DEFAULT '';
ALTER TABLE nhl_players ADD COLUMN injury_description TEXT NOT NULL DEFAULT '';
```

`injury_status` values: `"IR"`, `"DTD"`, `"LTIR"`, `"OUT"`, or `""` (healthy/unknown).

No new tables needed. Injury data is co-located with the player record in `nhl_players`, so every player-list query gets it with a single `LEFT JOIN`.

---

## Worker Routes

### Updated routes — add injury columns to response

All routes below add `LEFT JOIN nhl_players np ON np.player_id = tp.player_id` and include `injuryStatus: np.injury_status || ''` and `injuryDescription: np.injury_description || ''` in every player object returned:

- `GET /api/leagues/:id/teams/:teamId/players` — team roster
- `GET /api/leagues/:id/players` — PlayerExplorer
- `GET /api/leagues/:id/waivers` — waiver wire players
- `GET /api/leagues/:id/teams/:teamId/lineup/:periodId` — lineup players

### Updated route — player detail with landing data

**`GET /api/leagues/:id/players/:playerId`** (already exists)

Updated to also read from `player_landing_snapshots`. Returns:

```js
{
  // bio (from nhl_players)
  playerId, name, positionCode, nhlTeam, sweaterNum, headshotUrl,
  injuryStatus, injuryDescription,
  // landing data (from player_landing_snapshots, null if not yet cached)
  featuredStats: { season, regularSeason: { subSeason: { goals, assists, points, plusMinus, ... } } } | null,
  gameLog: [ { gameDate, opponentAbbrev, homeRoadFlag, goals, assists, points, ... } ] | null,  // last 5
  spotlightStories: [ { title, date, contributor, description } ] | null,
}
```

Falls back to bio-only if no landing snapshot exists yet.

---

## Client Components

### `PlayerStatusBadge` (`client/src/components/PlayerStatusBadge.jsx`)

Shared component used on every player row.

```jsx
// Props: { injuryStatus: string, injuryDescription: string }
// Renders nothing if injuryStatus is empty
```

Color mapping:
- `IR` / `LTIR` → red (`#ef4444`)
- `DTD` → orange (`#f97316`)
- `OUT` → dark red (`#991b1b`)

Rendered as a small `<span>` chip inline after the player name. `title` attribute shows `injuryDescription` on hover.

### Updated pages — injury badge + detail link

Every player row in the following pages gets:
1. Player name becomes a `<Link to={/leagues/${leagueId}/players/${playerId}}>` 
2. `<PlayerStatusBadge injuryStatus={...} injuryDescription={...} />` inline after the name

Pages updated:
- `client/src/pages/AddPlayers.jsx`
- `client/src/pages/TeamDetail.jsx`
- `client/src/pages/WaiverWirePage.jsx`
- `client/src/pages/LineupPage.jsx`
- `client/src/pages/PlayerExplorer.jsx`
- `client/src/pages/DraftPage.jsx`
- `client/src/pages/AuctionPage.jsx`

### `PlayerDetailPage` (`client/src/pages/PlayerDetailPage.jsx`)

Route: `/leagues/:leagueId/players/:playerId`
API: `GET /api/leagues/:id/players/:playerId` (via `api.leagues.player(leagueId, playerId)`)

**Layout (top to bottom):**

1. **Header** — headshot, full name, position badge, team crest (`teamCrestUrl(nhlTeam)`), sweater number, `PlayerStatusBadge`
2. **Injury banner** — alert bar shown only when `injuryStatus` is non-empty; displays `injuryStatus + ": " + injuryDescription`
3. **Current season stats grid** — pulled from `featuredStats.regularSeason.subSeason`:
   - Skaters: GP, G, A, PTS, +/-
   - Goalies: GP, W, L, GAA, SV%
   - Shown only when `featuredStats` is available
4. **Recent games table** — last 5 entries from `gameLog`: date, opponent, H/A, G, A, PTS (or GAA/SV% for goalies)
5. **News** — `spotlightStories` rendered as a card list: title, date, short description
6. **Loading / fallback** — spinner while loading; "No additional data available" when landing snapshot is absent

### `api.js` additions

```js
leagues: {
  // existing...
  playerDetail: (id, playerId) => request(`/api/leagues/${id}/players/${playerId}`),
}
```

(Note: `api.leagues.player(id, playerId)` already exists — this is the same endpoint, just confirming the client method name.)

### Route registration (`App.jsx`)

```jsx
<Route path="players/:playerId" element={<PlayerDetailPage />} />
```

Nested under the existing `leagues/:leagueId` `LeagueLayout` route.

---

## Cron Handler Order

In `worker/index.js` `scheduled` handler, append after `syncNhlRosters`:

```
syncNhlRosters(db)         // already exists
syncInjuries(db)           // NEW — fetch /v1/injury, update nhl_players
refreshRosteredPlayerLandings(db)  // NEW — refresh landing snapshots for rostered players
computeStandings(...)      // already exists
```

---

## Error Handling

- **Injury endpoint down:** log the error, leave existing `injury_status` values in place (stale is better than cleared)
- **Landing fetch fails for a player:** `Promise.allSettled` ensures one failure doesn't block others; failed players keep their existing snapshot
- **No landing snapshot:** player detail page shows bio + injury info only, no stats/news section
- **Player not in `nhl_players`:** injury columns `LEFT JOIN` produces nulls — treated as healthy/no badge

---

## Out of Scope

- Historical injury tracking (no audit log)
- Push/email alerts when a rostered player gets injured
- Third-party news sources (RotoWire, etc.)
- Goalie starts / probable starters
- Trade value or fantasy analysis
