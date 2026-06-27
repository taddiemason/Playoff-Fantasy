# Keepers & Dynasty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add keeper and dynasty league formats with a phase-based season lifecycle, commissioner-configurable keeper costs, and a taxi squad system for dynasty rosters.

**Architecture:** Two new columns on `leagues` (`league_format`, `phase`) drive a state machine through the season lifecycle. Season phase transitions are commissioner-triggered REST endpoints. Keeper designations are stored in a new table; roster history is snapshotted at season end. The existing DraftRoom/AuctionRoom DOs auto-advance the league phase on draft completion.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), React 18, React Router v6

## Global Constraints

- `league_format` values: `'redraft'` | `'keeper'` | `'dynasty'` — default `'redraft'`
- `phase` values: `'active'` | `'offseason'` | `'keeper_window'` | `'pre_draft'` | `'supplemental_draft'` — default `'active'`
- `is_taxi_squad` default: `0` (existing team_players rows unaffected)
- `max_keepers` default: `3`; `keeper_cost_type` default: `'free'`; `keeper_cost_inflation_pct` default: `20`; `taxi_squad_size` default: `3`
- `nextSeason('20242025')` → `'20252026'` (increment both years by 1)
- Season string advances: keeper format on `/keeper-window/close`; redraft + dynasty on `/season/start`
- Draft/auction session `status='completed'` auto-advances `league.phase`: redraft/keeper → `'active'`; dynasty → `'pre_draft'`
- All phase-transition endpoints: commissioner-only (403 otherwise); reject with 400 if wrong phase
- Keeper designation (`PUT /keepers`): team-owner-only — validates `teams.user_id === ctx.user.id`
- Taxi toggle (`PUT /taxi`): team-owner-only; rejects if `is_taxi_squad=1` and already at `taxi_squad_size`
- `roster_snapshots` is append-only (never deleted or updated after creation in `/season/end`)
- Supplemental draft reuses existing DraftRoom/AuctionRoom DO and draft/auction session tables unchanged
- `publicLeague()` in worker/index.js must include `league_format` and `phase`
- `// ── Season` route block goes immediately before the existing `// ── Draft` comment (line 1144)
- Import style in all client files: `import { api } from '../api'` (named export)

---

### Task 1: Migration 0015 + config defaults + publicLeague

**Files:**
- Create: `migrations/0015_keepers_dynasty.sql`
- Modify: `worker/index.js` (DEFAULT_LEAGUE_CONFIG, mergeConfig, publicLeague, PATCH league handler, nextSeason helper)

**Interfaces:**
- Produces: 4 new tables/columns; `config.max_keepers`, `config.keeper_cost_type`, `config.keeper_cost_inflation_pct`, `config.taxi_squad_size`; `league.league_format` and `league.phase` in all GET /api/leagues/:id responses; `nextSeason(season)` function usable in worker/index.js

- [ ] **Step 1: Create migrations/0015_keepers_dynasty.sql**

```sql
PRAGMA foreign_keys = ON;

ALTER TABLE leagues ADD COLUMN league_format TEXT NOT NULL DEFAULT 'redraft';
ALTER TABLE leagues ADD COLUMN phase TEXT NOT NULL DEFAULT 'active';

ALTER TABLE team_players ADD COLUMN is_taxi_squad INTEGER NOT NULL DEFAULT 0;

CREATE TABLE keeper_designations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id        INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_id          INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id        INTEGER NOT NULL,
  player_name      TEXT NOT NULL,
  player_meta_json TEXT NOT NULL DEFAULT '{}',
  cost_type        TEXT NOT NULL DEFAULT 'free',
  cost_value       INTEGER NOT NULL DEFAULT 0,
  season           TEXT NOT NULL,
  designated_at    TEXT NOT NULL,
  UNIQUE(league_id, team_id, player_id, season)
);

CREATE TABLE roster_snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id         INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_id           INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id         INTEGER NOT NULL,
  player_name       TEXT NOT NULL,
  player_meta_json  TEXT NOT NULL DEFAULT '{}',
  season            TEXT NOT NULL,
  was_keeper        INTEGER NOT NULL DEFAULT 0,
  keeper_cost_type  TEXT,
  keeper_cost_value INTEGER,
  snapshotted_at    TEXT NOT NULL
);
```

- [ ] **Step 2: Add nextSeason helper to worker/index.js**

Find `function getCurrentSeason()` (line ~39) and add immediately after its closing brace:

```js
function nextSeason(season) {
  const s = parseInt(season.slice(0, 4), 10);
  return `${s + 1}${s + 2}`;
}
```

- [ ] **Step 3: Add config keys to DEFAULT_LEAGUE_CONFIG**

Find the `const DEFAULT_LEAGUE_CONFIG = {` block (line ~228). After `bid_timer_seconds: 30,` add:

```js
  max_keepers: 3,
  keeper_cost_type: 'free',
  keeper_cost_inflation_pct: 20,
  taxi_squad_size: 3,
```

- [ ] **Step 4: Add config keys to mergeConfig**

In the `mergeConfig` function (line ~251), after `bid_timer_seconds: parsed.bid_timer_seconds ?? d.bid_timer_seconds,` add:

```js
    max_keepers: parsed.max_keepers ?? d.max_keepers,
    keeper_cost_type: parsed.keeper_cost_type ?? d.keeper_cost_type,
    keeper_cost_inflation_pct: parsed.keeper_cost_inflation_pct ?? d.keeper_cost_inflation_pct,
    taxi_squad_size: parsed.taxi_squad_size ?? d.taxi_squad_size,
```

- [ ] **Step 5: Add league_format and phase to publicLeague**

Find `function publicLeague(league, extra = {})` (line ~336). After `is_locked: !!league.is_locked,` add:

```js
    league_format: league.league_format || 'redraft',
    phase: league.phase || 'active',
```

- [ ] **Step 6: Add league_format to PATCH /api/leagues/:id handler**

In the PATCH league handler (line ~894), find the block that handles `body.is_locked` and add immediately after it:

```js
    if (body.league_format !== undefined) {
      if (!['redraft', 'keeper', 'dynasty'].includes(body.league_format))
        return json({ error: 'Invalid league_format' }, { status: 400 });
      fields.push('league_format = ?'); values.push(body.league_format);
    }
```

- [ ] **Step 7: Verify syntax**

```
node --check worker/index.js
```

Expected: no output (exit 0).

- [ ] **Step 8: Commit**

```
git add migrations/0015_keepers_dynasty.sql worker/index.js
git commit -m "feat: migration 0015 keeper/dynasty tables, phase lifecycle columns, config defaults"
```

---

### Task 2: Season lifecycle REST routes + draft completion phase auto-advance

**Files:**
- Modify: `worker/index.js` (5 new POST endpoints in new `// ── Season` section before `// ── Draft`)
- Modify: `worker/draft-room.js` (auto-advance league.phase on completion)
- Modify: `worker/auction-room.js` (auto-advance league.phase on completion)

**Interfaces:**
- Consumes: `nextSeason()`, `loadLeagueContext`, `isCommissioner`, `parseId`, `mergeConfig`, `json` — all defined in worker/index.js; `this.leagueId` and `this.env.DB` in both DOs
- Produces: `POST /api/leagues/:id/season/end` → `{ok:true}`; `POST /api/leagues/:id/season/keeper-window/open` → `{ok:true}`; `POST /api/leagues/:id/season/keeper-window/close` → `{ok:true, nextSeason}`; `POST /api/leagues/:id/season/start` → `{ok:true}`; `POST /api/leagues/:id/season/activate` → `{ok:true}`

- [ ] **Step 1: Add `// ── Season` block to worker/index.js**

Find the comment `// ── Draft` (line ~1144). Insert the following complete block immediately before it:

```js
  // ── Season lifecycle ────────────────────────────────────────────────────────

  // POST /api/leagues/:id/season/end
  if (method === 'POST' && pathname.match(/^\/api\/leagues\/\d+\/season\/end$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id))
      return json({ error: 'Commissioner only' }, { status: 403 });
    if (ctx.league.phase !== 'active')
      return json({ error: `Cannot end season in phase: ${ctx.league.phase}` }, { status: 400 });

    const { results: allPlayers } = await db.prepare(
      `SELECT tp.team_id, tp.player_id, tp.player_name, tp.position, tp.nhl_team,
              tp.headshot_url, tp.crest_url
       FROM team_players tp
       JOIN teams t ON t.id = tp.team_id
       WHERE t.league_id = ?`
    ).bind(leagueId).all();

    const now = new Date().toISOString();
    if (allPlayers && allPlayers.length > 0) {
      const snapshots = allPlayers.map(p =>
        db.prepare(
          `INSERT OR IGNORE INTO roster_snapshots
             (league_id, team_id, player_id, player_name, player_meta_json, season, was_keeper, snapshotted_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
        ).bind(leagueId, p.team_id, p.player_id, p.player_name,
               JSON.stringify({ position: p.position || '', nhl_team: p.nhl_team || '',
                                headshot_url: p.headshot_url || '', crest_url: p.crest_url || '' }),
               ctx.league.season, now)
      );
      for (let i = 0; i < snapshots.length; i += 100) {
        await db.batch(snapshots.slice(i, i + 100));
      }
    }

    await db.prepare("UPDATE leagues SET phase = 'offseason' WHERE id = ?").bind(leagueId).run();
    return json({ ok: true });
  }

  // POST /api/leagues/:id/season/keeper-window/open
  if (method === 'POST' && pathname.match(/^\/api\/leagues\/\d+\/season\/keeper-window\/open$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id))
      return json({ error: 'Commissioner only' }, { status: 403 });
    if (ctx.league.league_format !== 'keeper')
      return json({ error: 'Only keeper-format leagues have a keeper window' }, { status: 400 });
    if (ctx.league.phase !== 'offseason')
      return json({ error: `Cannot open keeper window in phase: ${ctx.league.phase}` }, { status: 400 });
    await db.prepare("UPDATE leagues SET phase = 'keeper_window' WHERE id = ?").bind(leagueId).run();
    return json({ ok: true });
  }

  // POST /api/leagues/:id/season/keeper-window/close
  if (method === 'POST' && pathname.match(/^\/api\/leagues\/\d+\/season\/keeper-window\/close$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id))
      return json({ error: 'Commissioner only' }, { status: 403 });
    if (ctx.league.phase !== 'keeper_window')
      return json({ error: `Cannot close keeper window in phase: ${ctx.league.phase}` }, { status: 400 });

    const currentSeason = ctx.league.season;
    // Mark designated keepers in roster_snapshots
    const { results: kd } = await db.prepare(
      'SELECT team_id, player_id, cost_type, cost_value FROM keeper_designations WHERE league_id = ? AND season = ?'
    ).bind(leagueId, currentSeason).all();

    if (kd && kd.length > 0) {
      const updateSnaps = kd.map(k =>
        db.prepare(
          `UPDATE roster_snapshots SET was_keeper = 1, keeper_cost_type = ?, keeper_cost_value = ?
           WHERE league_id = ? AND team_id = ? AND player_id = ? AND season = ?`
        ).bind(k.cost_type, k.cost_value, leagueId, k.team_id, k.player_id, currentSeason)
      );
      for (let i = 0; i < updateSnaps.length; i += 100) {
        await db.batch(updateSnaps.slice(i, i + 100));
      }
    }

    // Delete non-keeper players from team_players
    const keeperSet = new Set((kd || []).map(k => `${k.team_id}-${k.player_id}`));
    const { results: allTp } = await db.prepare(
      `SELECT tp.id, tp.team_id, tp.player_id FROM team_players tp
       JOIN teams t ON t.id = tp.team_id WHERE t.league_id = ?`
    ).bind(leagueId).all();
    const toDelete = (allTp || []).filter(p => !keeperSet.has(`${p.team_id}-${p.player_id}`));
    if (toDelete.length > 0) {
      const delStmts = toDelete.map(p => db.prepare('DELETE FROM team_players WHERE id = ?').bind(p.id));
      for (let i = 0; i < delStmts.length; i += 100) {
        await db.batch(delStmts.slice(i, i + 100));
      }
    }

    const ns = nextSeason(currentSeason);
    await db.prepare("UPDATE leagues SET phase = 'pre_draft', season = ? WHERE id = ?").bind(ns, leagueId).run();
    return json({ ok: true, nextSeason: ns });
  }

  // POST /api/leagues/:id/season/start
  if (method === 'POST' && pathname.match(/^\/api\/leagues\/\d+\/season\/start$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id))
      return json({ error: 'Commissioner only' }, { status: 403 });
    if (ctx.league.league_format === 'keeper')
      return json({ error: 'Keeper leagues use the keeper window flow' }, { status: 400 });
    if (ctx.league.phase !== 'offseason')
      return json({ error: `Cannot start new season in phase: ${ctx.league.phase}` }, { status: 400 });
    const ns = nextSeason(ctx.league.season);
    const newPhase = ctx.league.league_format === 'dynasty' ? 'supplemental_draft' : 'pre_draft';
    await db.prepare('UPDATE leagues SET phase = ?, season = ? WHERE id = ?').bind(newPhase, ns, leagueId).run();
    return json({ ok: true, nextSeason: ns, phase: newPhase });
  }

  // POST /api/leagues/:id/season/activate
  if (method === 'POST' && pathname.match(/^\/api\/leagues\/\d+\/season\/activate$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id))
      return json({ error: 'Commissioner only' }, { status: 403 });
    if (ctx.league.phase !== 'pre_draft')
      return json({ error: `Cannot activate season in phase: ${ctx.league.phase}` }, { status: 400 });

    if (ctx.league.league_format === 'dynasty') {
      const config = mergeConfig(ctx.league.config_json);
      const maxRoster = config.roster.maxF + config.roster.maxD + config.roster.maxG;
      const { results: overLimit } = await db.prepare(
        `SELECT t.id, t.name,
                COUNT(CASE WHEN tp.is_taxi_squad = 0 THEN 1 END) AS main_count,
                COUNT(CASE WHEN tp.is_taxi_squad = 1 THEN 1 END) AS taxi_count
         FROM teams t
         LEFT JOIN team_players tp ON tp.team_id = t.id
         WHERE t.league_id = ?
         GROUP BY t.id
         HAVING main_count > ? OR taxi_count > ?`
      ).bind(leagueId, maxRoster, config.taxi_squad_size).all();
      if (overLimit && overLimit.length > 0) {
        return json({
          error: 'Cannot activate: some teams are over their roster or taxi squad limit',
          teams: overLimit,
        }, { status: 400 });
      }
    }

    await db.prepare("UPDATE leagues SET phase = 'active' WHERE id = ?").bind(leagueId).run();
    return json({ ok: true });
  }

```

- [ ] **Step 2: Auto-advance league.phase in DraftRoom when draft completes**

In `worker/draft-room.js`, find the two places where `"UPDATE draft_sessions SET status = 'completed'"` is written (lines ~299 and ~328). In each block, immediately after the `completed_at` update, add the league phase auto-advance.

First location (after line ~301, inside `if (nextPick >= this.totalPicks)`):

```js
      await this.env.DB.prepare(
        `UPDATE leagues SET phase = CASE WHEN league_format = 'dynasty' THEN 'pre_draft' ELSE 'active' END WHERE id = ?`
      ).bind(this.leagueId).run();
```

Second location (inside `autoPickForCurrentTeam`, after the `completed_at` update, line ~328):

```js
      await this.env.DB.prepare(
        `UPDATE leagues SET phase = CASE WHEN league_format = 'dynasty' THEN 'pre_draft' ELSE 'active' END WHERE id = ?`
      ).bind(this.leagueId).run();
```

- [ ] **Step 3: Auto-advance league.phase in AuctionRoom when auction completes**

In `worker/auction-room.js`, find the `isLast` completion block inside `awardCurrentNomination` — it contains `"UPDATE auction_sessions SET status = 'completed'"`. After that `await` block completes and before `this.broadcastAll()`, add:

```js
      await this.env.DB.prepare(
        `UPDATE leagues SET phase = CASE WHEN league_format = 'dynasty' THEN 'pre_draft' ELSE 'active' END WHERE id = ?`
      ).bind(this.leagueId).run();
```

- [ ] **Step 4: Verify syntax**

```
node --check worker/index.js && node --check worker/draft-room.js && node --check worker/auction-room.js
```

Expected: no output (exit 0 for all three).

- [ ] **Step 5: Commit**

```
git add worker/index.js worker/draft-room.js worker/auction-room.js
git commit -m "feat: season lifecycle REST routes (end/start/activate/keeper-window) + draft completion phase auto-advance"
```

---

### Task 3: Keeper designation + taxi REST routes

**Files:**
- Modify: `worker/index.js` only (5 new routes added to the `// ── Season` block from Task 2)

**Interfaces:**
- Consumes: `loadLeagueContext`, `isCommissioner`, `parseId`, `mergeConfig`, `json`; D1 tables: `keeper_designations`, `roster_snapshots`, `team_players`, `teams`, `draft_picks`, `draft_sessions`, `auction_picks`, `auction_sessions`
- Produces: `GET /keepers` → `{designations, config, myTeamId, myRoster, teams}`; `PUT /keepers` → `{ok, designations}`; `DELETE /keepers/:playerId` → `{ok}`; `PUT /taxi` → `{ok}`; `GET /roster-snapshots` → `{snapshots}`

- [ ] **Step 1: Add keeper + taxi routes to worker/index.js**

Find the closing brace of the `// POST /api/leagues/:id/season/activate` block from Task 2. Add the following immediately after it (still inside the `// ── Season` section, before the `// ── Draft` comment):

```js
  // GET /api/leagues/:id/keepers
  if (method === 'GET' && pathname.match(/^\/api\/leagues\/\d+\/keepers$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    const config = mergeConfig(ctx.league.config_json);

    // All designations for current season
    const { results: designations } = await db.prepare(
      'SELECT * FROM keeper_designations WHERE league_id = ? AND season = ? ORDER BY team_id, player_name'
    ).bind(leagueId, ctx.league.season).all();

    // My team
    const myTeam = await db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id = ?')
      .bind(leagueId, ctx.user.id).first();

    // My roster with cost_value pre-calculated
    let myRoster = [];
    if (myTeam) {
      const { results: players } = await db.prepare(
        `SELECT tp.player_id, tp.player_name, tp.position, tp.nhl_team, tp.headshot_url, tp.crest_url
         FROM team_players tp WHERE tp.team_id = ?`
      ).bind(myTeam.id).all();

      myRoster = await Promise.all((players || []).map(async (p) => {
        let costValue = 0;
        if (config.keeper_cost_type === 'pick_round') {
          const row = await db.prepare(
            `SELECT dp.round FROM draft_picks dp
             JOIN draft_sessions ds ON ds.id = dp.draft_session_id
             WHERE ds.league_id = ? AND dp.player_id = ?
             ORDER BY dp.picked_at DESC LIMIT 1`
          ).bind(leagueId, p.player_id).first();
          costValue = row?.round ?? 0;
        } else if (config.keeper_cost_type === 'auction_inflation') {
          const row = await db.prepare(
            `SELECT ap.amount FROM auction_picks ap
             JOIN auction_sessions asess ON asess.id = ap.auction_session_id
             WHERE asess.league_id = ? AND ap.player_id = ?
             ORDER BY ap.picked_at DESC LIMIT 1`
          ).bind(leagueId, p.player_id).first();
          const base = row?.amount ?? 0;
          costValue = Math.round(base * (1 + config.keeper_cost_inflation_pct / 100));
        }
        return { ...p, costValue };
      }));
    }

    // All teams' designation counts (for commissioner readiness)
    const { results: allTeams } = await db.prepare('SELECT id, name FROM teams WHERE league_id = ? ORDER BY name').bind(leagueId).all();
    const countMap = {};
    for (const d of (designations || [])) {
      countMap[d.team_id] = (countMap[d.team_id] || 0) + 1;
    }
    const teams = (allTeams || []).map(t => ({ ...t, designationCount: countMap[t.id] || 0 }));

    return json({
      designations: designations || [],
      config: {
        maxKeepers: config.max_keepers,
        keeperCostType: config.keeper_cost_type,
        keeperCostInflationPct: config.keeper_cost_inflation_pct,
      },
      myTeamId: myTeam?.id ?? null,
      myRoster,
      teams,
    });
  }

  // PUT /api/leagues/:id/keepers
  if (method === 'PUT' && pathname.match(/^\/api\/leagues\/\d+\/keepers$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (ctx.league.phase !== 'keeper_window')
      return json({ error: 'Keeper window is not open' }, { status: 400 });

    const myTeam = await db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id = ?')
      .bind(leagueId, ctx.user.id).first();
    if (!myTeam) return json({ error: 'You do not have a team in this league' }, { status: 403 });

    const config = mergeConfig(ctx.league.config_json);
    const body = await request.json();
    const keepers = Array.isArray(body.keepers) ? body.keepers : [];

    if (keepers.length > config.max_keepers)
      return json({ error: `Maximum ${config.max_keepers} keepers allowed` }, { status: 400 });

    const now = new Date().toISOString();
    const currentSeason = ctx.league.season;

    // Calculate cost for each keeper
    const upserts = await Promise.all(keepers.map(async (k) => {
      let costValue = 0;
      const costType = config.keeper_cost_type;
      if (costType === 'pick_round') {
        const row = await db.prepare(
          `SELECT dp.round FROM draft_picks dp
           JOIN draft_sessions ds ON ds.id = dp.draft_session_id
           WHERE ds.league_id = ? AND dp.player_id = ?
           ORDER BY dp.picked_at DESC LIMIT 1`
        ).bind(leagueId, k.playerId).first();
        costValue = row?.round ?? 0;
      } else if (costType === 'auction_inflation') {
        const row = await db.prepare(
          `SELECT ap.amount FROM auction_picks ap
           JOIN auction_sessions asess ON asess.id = ap.auction_session_id
           WHERE asess.league_id = ? AND ap.player_id = ?
           ORDER BY ap.picked_at DESC LIMIT 1`
        ).bind(leagueId, k.playerId).first();
        const base = row?.amount ?? 0;
        costValue = Math.round(base * (1 + config.keeper_cost_inflation_pct / 100));
      }
      const meta = JSON.stringify(k.playerMeta || {});
      return db.prepare(
        `INSERT INTO keeper_designations
           (league_id, team_id, player_id, player_name, player_meta_json, cost_type, cost_value, season, designated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(league_id, team_id, player_id, season) DO UPDATE SET
           player_name = excluded.player_name,
           player_meta_json = excluded.player_meta_json,
           cost_type = excluded.cost_type,
           cost_value = excluded.cost_value,
           designated_at = excluded.designated_at`
      ).bind(leagueId, myTeam.id, k.playerId, k.playerName, meta, costType, costValue, currentSeason, now);
    }));

    // Delete designations not in new list
    const keepingIds = keepers.map(k => k.playerId);
    const { results: existing } = await db.prepare(
      'SELECT player_id FROM keeper_designations WHERE league_id = ? AND team_id = ? AND season = ?'
    ).bind(leagueId, myTeam.id, currentSeason).all();
    const toRemove = (existing || []).filter(e => !keepingIds.includes(e.player_id));
    const deleteStmts = toRemove.map(e =>
      db.prepare('DELETE FROM keeper_designations WHERE league_id = ? AND team_id = ? AND player_id = ? AND season = ?')
        .bind(leagueId, myTeam.id, e.player_id, currentSeason)
    );

    const allStmts = [...upserts, ...deleteStmts];
    for (let i = 0; i < allStmts.length; i += 100) {
      await db.batch(allStmts.slice(i, i + 100));
    }

    const { results: designations } = await db.prepare(
      'SELECT * FROM keeper_designations WHERE league_id = ? AND team_id = ? AND season = ?'
    ).bind(leagueId, myTeam.id, currentSeason).all();
    return json({ ok: true, designations: designations || [] });
  }

  // DELETE /api/leagues/:id/keepers/:playerId
  if (method === 'DELETE' && pathname.match(/^\/api\/leagues\/\d+\/keepers\/\d+$/)) {
    const parts = pathname.split('/');
    const leagueId = parseId(parts[3]);
    const playerId = parseId(parts[5]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (ctx.league.phase !== 'keeper_window')
      return json({ error: 'Keeper window is not open' }, { status: 400 });
    const myTeam = await db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id = ?')
      .bind(leagueId, ctx.user.id).first();
    if (!myTeam) return json({ error: 'No team found' }, { status: 403 });
    await db.prepare(
      'DELETE FROM keeper_designations WHERE league_id = ? AND team_id = ? AND player_id = ? AND season = ?'
    ).bind(leagueId, myTeam.id, playerId, ctx.league.season).run();
    return json({ ok: true });
  }

  // PUT /api/leagues/:id/taxi
  if (method === 'PUT' && pathname.match(/^\/api\/leagues\/\d+\/taxi$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (ctx.league.league_format !== 'dynasty')
      return json({ error: 'Taxi squad is only available in dynasty leagues' }, { status: 400 });
    const myTeam = await db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id = ?')
      .bind(leagueId, ctx.user.id).first();
    if (!myTeam) return json({ error: 'No team found' }, { status: 403 });
    const body = await request.json();
    const { player_id, is_taxi_squad } = body;
    if (typeof player_id !== 'number' || typeof is_taxi_squad !== 'boolean')
      return json({ error: 'player_id (number) and is_taxi_squad (boolean) required' }, { status: 400 });

    if (is_taxi_squad) {
      const config = mergeConfig(ctx.league.config_json);
      const taxiCount = await db.prepare(
        'SELECT COUNT(*) AS c FROM team_players WHERE team_id = ? AND is_taxi_squad = 1'
      ).bind(myTeam.id).first();
      if ((taxiCount?.c ?? 0) >= config.taxi_squad_size)
        return json({ error: `Taxi squad is full (max ${config.taxi_squad_size})` }, { status: 400 });
    }

    await db.prepare(
      'UPDATE team_players SET is_taxi_squad = ? WHERE team_id = ? AND player_id = ?'
    ).bind(is_taxi_squad ? 1 : 0, myTeam.id, player_id).run();
    return json({ ok: true });
  }

  // GET /api/leagues/:id/roster-snapshots
  if (method === 'GET' && pathname.match(/^\/api\/leagues\/\d+\/roster-snapshots$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    const { results } = await db.prepare(
      `SELECT rs.*, t.name AS team_name
       FROM roster_snapshots rs
       JOIN teams t ON t.id = rs.team_id
       WHERE rs.league_id = ?
       ORDER BY rs.season DESC, rs.team_id, rs.player_name`
    ).bind(leagueId).all();
    return json({ snapshots: results || [] });
  }

```

- [ ] **Step 2: Verify syntax**

```
node --check worker/index.js
```

Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```
git add worker/index.js
git commit -m "feat: keeper designation routes (GET/PUT/DELETE keepers, PUT taxi, GET roster-snapshots)"
```

---

### Task 4: API client + route + nav + placeholder KeepersPage

**Files:**
- Modify: `client/src/api.js`
- Modify: `client/src/App.jsx`
- Modify: `client/src/components/LeagueLayout.jsx`
- Create: `client/src/pages/KeepersPage.jsx`

**Interfaces:**
- Produces: `api.leagues.season.*`, `api.leagues.keepers.*`, `api.leagues.taxi.*`, `api.leagues.rosterSnapshots()`; `/leagues/:id/keepers` route; "Keepers" NavLink (when `league_format !== 'redraft'`); phase-aware banner in LeagueLayout

- [ ] **Step 1: Add api methods to client/src/api.js**

Find the `auction: { ... },` block (ends around line 213). Add immediately after it (still inside `leagues`):

```js
    season: {
      end:              (id) => request(`/api/leagues/${id}/season/end`, { method: 'POST' }),
      start:            (id) => request(`/api/leagues/${id}/season/start`, { method: 'POST' }),
      activate:         (id) => request(`/api/leagues/${id}/season/activate`, { method: 'POST' }),
      openKeeperWindow: (id) => request(`/api/leagues/${id}/season/keeper-window/open`, { method: 'POST' }),
      closeKeeperWindow:(id) => request(`/api/leagues/${id}/season/keeper-window/close`, { method: 'POST' }),
    },

    keepers: {
      get:    (id) => request(`/api/leagues/${id}/keepers`),
      set:    (id, keepers) => request(`/api/leagues/${id}/keepers`, {
        method: 'PUT', body: JSON.stringify({ keepers }),
      }),
      remove: (id, playerId) => request(`/api/leagues/${id}/keepers/${playerId}`, { method: 'DELETE' }),
    },

    taxi: {
      set: (id, playerId, isTaxiSquad) => request(`/api/leagues/${id}/taxi`, {
        method: 'PUT', body: JSON.stringify({ player_id: playerId, is_taxi_squad: isTaxiSquad }),
      }),
    },

    rosterSnapshots: (id) => request(`/api/leagues/${id}/roster-snapshots`),
```

- [ ] **Step 2: Add KeepersPage route to client/src/App.jsx**

Add import after the AuctionPage import:

```js
import KeepersPage from './pages/KeepersPage.jsx';
```

Add route after `<Route path="auction" element={<AuctionPage />} />`:

```jsx
<Route path="keepers" element={<KeepersPage />} />
```

- [ ] **Step 3: Add phase banner + Keepers nav link to LeagueLayout.jsx**

Replace the current `LeagueLayout` default export with this complete version:

```jsx
const PHASE_MESSAGES = {
  offseason: 'Season ended — waiting for the commissioner to start the next season.',
  keeper_window: 'Keeper window is open — designate your keepers before the commissioner closes it.',
  supplemental_draft: 'Supplemental draft in progress.',
  pre_draft: 'Season starting soon — finalize your roster.',
};

export default function LeagueLayout() {
  const { leagueId } = useParams()
  const { user, loading: authLoading } = useAuth()
  const location = useLocation()
  const [league, setLeague] = useState(null)
  const [status, setStatus] = useState('loading')
  const [errorMsg, setErrorMsg] = useState('')

  const refreshLeague = useCallback(async () => {
    try {
      const lg = await api.leagues.get(leagueId)
      setLeague(lg)
      setStatus('ok')
    } catch (err) {
      setErrorMsg(err.message || 'Could not load league')
      setStatus('error')
    }
  }, [leagueId])

  useEffect(() => { if (user) refreshLeague() }, [user, refreshLeague])

  if (authLoading || (user && status === 'loading')) {
    return <div className="loading-state"><span className="loading-spinner"></span> Loading league…</div>
  }
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />
  if (status === 'error') {
    return (
      <div>
        <Link to="/dashboard" className="back-link">← Back to Dashboard</Link>
        <div className="alert alert-error">{errorMsg}</div>
      </div>
    )
  }

  const tab = (isActive) => `league-tab${isActive ? ' active' : ''}`
  const isCommissioner = league?.role === 'commissioner'
  const showKeepers = league?.league_format && league.league_format !== 'redraft'
  const phaseMsg = league?.phase && league.phase !== 'active' ? PHASE_MESSAGES[league.phase] : null

  return (
    <div>
      <div className="league-nav">
        <NavLink end to={`/leagues/${leagueId}`} className={({ isActive }) => tab(isActive)}>Home</NavLink>
        <NavLink to={`/leagues/${leagueId}/standings`} className={({ isActive }) => tab(isActive)}>Standings</NavLink>
        <NavLink to={`/leagues/${leagueId}/matchup`} className={({ isActive }) => tab(isActive)}>Matchup</NavLink>
        <NavLink to={`/leagues/${leagueId}/lineup`} className={({ isActive }) => tab(isActive)}>Lineup</NavLink>
        <NavLink to={`/leagues/${leagueId}/schedule`} className={({ isActive }) => tab(isActive)}>Schedule</NavLink>
        <NavLink to={`/leagues/${leagueId}/waivers`} className={({ isActive }) => tab(isActive)}>Waivers</NavLink>
        <NavLink to={`/leagues/${leagueId}/trades`} className={({ isActive }) => tab(isActive)}>Trades</NavLink>
        <NavLink to={`/leagues/${leagueId}/draft`} className={({ isActive }) => tab(isActive)}>Draft</NavLink>
        <NavLink to={`/leagues/${leagueId}/auction`} className={({ isActive }) => tab(isActive)}>Auction</NavLink>
        {showKeepers && (
          <NavLink to={`/leagues/${leagueId}/keepers`} className={({ isActive }) => tab(isActive)}>Keepers</NavLink>
        )}
        <NavLink to={`/leagues/${leagueId}/rules`} className={({ isActive }) => tab(isActive)}>Rules</NavLink>
        <NavLink to={`/leagues/${leagueId}/players`} className={({ isActive }) => tab(isActive)}>Players</NavLink>
        <NavLink to={`/leagues/${leagueId}/add-players`} className={({ isActive }) => tab(isActive)}>Add Players</NavLink>
        {isCommissioner && <NavLink to={`/leagues/${leagueId}/admin`} className={({ isActive }) => tab(isActive)}>Manage</NavLink>}
      </div>
      {phaseMsg && (
        <div style={{ background: '#2c3e50', borderBottom: '1px solid #34495e', padding: '8px 16px', fontSize: '0.85rem', color: '#bdc3c7' }}>
          {phaseMsg}
        </div>
      )}
      <Outlet context={{ league, refreshLeague }} />
    </div>
  )
}
```

- [ ] **Step 4: Create placeholder client/src/pages/KeepersPage.jsx**

```jsx
import { useParams } from 'react-router-dom';

export default function KeepersPage() {
  const { leagueId } = useParams();
  return (
    <div className="page-content">
      <p>Keepers — league {leagueId} — coming soon</p>
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```
git add client/src/api.js client/src/App.jsx client/src/components/LeagueLayout.jsx client/src/pages/KeepersPage.jsx
git commit -m "feat: keeper/season API client methods, Keepers route, phase banner in LeagueLayout"
```

---

### Task 5: KeepersPage full implementation

**Files:**
- Modify: `client/src/pages/KeepersPage.jsx` (replace placeholder)

**Interfaces:**
- Consumes: `api.leagues.keepers.get(id)`, `api.leagues.keepers.set(id, keepers)`, `api.leagues.rosterSnapshots(id)`, `useOutletContext()` → `{ league, refreshLeague }`, `useParams()` → `{ leagueId }`
- Produces: Full KeepersPage with team-owner keeper designation view + commissioner readiness view

- [ ] **Step 1: Replace KeepersPage.jsx with full implementation**

```jsx
import { useState, useEffect } from 'react';
import { useParams, useOutletContext } from 'react-router-dom';
import { api } from '../api';

function CostBadge({ costType, costValue }) {
  if (costType === 'free') return <span style={{ color: '#27ae60', fontSize: '0.75rem' }}>Free</span>;
  if (costType === 'none') return <span style={{ color: '#888', fontSize: '0.75rem' }}>Manual</span>;
  if (costType === 'pick_round') return <span style={{ color: '#e67e22', fontSize: '0.75rem' }}>Round {costValue || '—'}</span>;
  if (costType === 'auction_inflation') return <span style={{ color: '#e67e22', fontSize: '0.75rem' }}>${costValue || '—'}</span>;
  return null;
}

function TeamOwnerView({ leagueId, keeperData, phase }) {
  const { myRoster, designations, config } = keeperData;
  const { maxKeepers, keeperCostType } = config;
  const myDesignatedIds = new Set(designations.map(d => d.player_id));

  const [selected, setSelected] = useState(() => new Set(myDesignatedIds));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const isOpen = phase === 'keeper_window';

  function toggle(playerId) {
    if (!isOpen) return;
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(playerId)) { next.delete(playerId); } else {
        if (next.size >= maxKeepers) { setMsg(`Maximum ${maxKeepers} keepers allowed`); return prev; }
        next.add(playerId);
      }
      setMsg('');
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setMsg('');
    try {
      const keepers = myRoster
        .filter(p => selected.has(p.player_id))
        .map(p => ({
          playerId: p.player_id,
          playerName: p.player_name,
          playerMeta: { position: p.position, nhlTeam: p.nhl_team, headshotUrl: p.headshot_url || '', crestUrl: p.crest_url || '' },
        }));
      await api.leagues.keepers.set(leagueId, keepers);
      setMsg('Keepers saved.');
    } catch (e) { setMsg(e.message); }
    setSaving(false);
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <h3 style={{ margin: 0 }}>Your Keepers</h3>
        <span style={{ color: '#888', fontSize: '0.85rem' }}>{selected.size} / {maxKeepers} designated</span>
      </div>

      {!isOpen && (
        <p style={{ color: '#888', marginBottom: '1rem' }}>
          {phase === 'offseason' ? 'Keeper window not yet open.' : 'Keeper window is closed.'}
        </p>
      )}

      {myRoster.length === 0 && <p style={{ color: '#888' }}>No players on your roster.</p>}

      {myRoster.map(p => {
        const isKeeper = selected.has(p.player_id);
        return (
          <div
            key={p.player_id}
            onClick={() => toggle(p.player_id)}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.75rem',
              padding: '8px 12px', marginBottom: 4,
              border: `1px solid ${isKeeper ? '#27ae60' : '#333'}`,
              borderRadius: 6, cursor: isOpen ? 'pointer' : 'default',
              background: isKeeper ? 'rgba(39,174,96,0.08)' : 'transparent',
            }}
          >
            {p.headshot_url && <img src={p.headshot_url} alt="" style={{ width: 32, height: 32, borderRadius: '50%' }} />}
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: isKeeper ? 'bold' : 'normal' }}>{p.player_name}</div>
              <div style={{ fontSize: '0.75rem', color: '#888' }}>{p.position} · {p.nhl_team}</div>
            </div>
            <CostBadge costType={keeperCostType} costValue={p.costValue} />
            {isKeeper && <span style={{ color: '#27ae60', fontSize: '0.8rem' }}>✓ Keeping</span>}
          </div>
        );
      })}

      {isOpen && (
        <div style={{ marginTop: '1rem' }}>
          <button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Keepers'}</button>
          {msg && <span style={{ marginLeft: '0.75rem', color: msg.includes('saved') ? '#27ae60' : '#e74c3c', fontSize: '0.85rem' }}>{msg}</span>}
        </div>
      )}
    </div>
  );
}

function CommissionerView({ keeperData }) {
  const { teams, config, designations } = keeperData;
  const { maxKeepers } = config;
  const countMap = {};
  for (const d of designations) {
    countMap[d.team_id] = (countMap[d.team_id] || 0) + 1;
  }
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Keeper Designations — All Teams</h3>
      {teams.map(t => {
        const count = countMap[t.id] || 0;
        const ready = count === maxKeepers;
        return (
          <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #222' }}>
            <span>{t.name}</span>
            <span style={{ color: ready ? '#27ae60' : '#888' }}>{count} / {maxKeepers}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function KeepersPage() {
  const { leagueId } = useParams();
  const { league } = useOutletContext();
  const [keeperData, setKeeperData] = useState(null);
  const [loading, setLoading] = useState(true);

  const isCommissioner = league?.role === 'commissioner';

  useEffect(() => {
    api.leagues.keepers.get(leagueId)
      .then(d => setKeeperData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [leagueId]);

  if (loading) return <div className="page-content"><p>Loading keepers…</p></div>;
  if (!keeperData) return <div className="page-content"><p>Could not load keeper data.</p></div>;

  return (
    <div className="page-content">
      {isCommissioner
        ? <CommissionerView keeperData={keeperData} />
        : <TeamOwnerView leagueId={leagueId} keeperData={keeperData} phase={league?.phase} />
      }
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```
git add client/src/pages/KeepersPage.jsx
git commit -m "feat: KeepersPage — team-owner designation view + commissioner readiness panel"
```

---

### Task 6: CommissionerDashboard Season Management section

**Files:**
- Modify: `client/src/pages/CommissionerDashboard.jsx`

**Interfaces:**
- Consumes: `api.leagues.season.*`, `api.leagues.update(id, data)`, `api.leagues.keepers.get(id)`, `useOutletContext()` → `{ league, refreshLeague }`, `useParams()` → `{ leagueId }`
- Produces: Season Management card with league format selector, keeper/dynasty config inputs, and the single valid phase-action button

- [ ] **Step 1: Read CommissionerDashboard.jsx to understand existing structure**

Before editing, read the full file to find:
- Where state declarations are (add season management state after existing draft/auction state)
- Where handler functions are (add after existing handlers)
- Where the auction setup card ends (add Season Management card after it)

- [ ] **Step 2: Add state vars for season management**

After the existing `auctionSession`, `auctionMsg`, `auctionBudget`, `bidTimer` state vars, add:

```js
const [leagueFormat, setLeagueFormat] = useState(() => league?.league_format ?? 'redraft');
const [maxKeepers, setMaxKeepers] = useState(() => league?.config?.max_keepers ?? 3);
const [keeperCostType, setKeeperCostType] = useState(() => league?.config?.keeper_cost_type ?? 'free');
const [keeperInflationPct, setKeeperInflationPct] = useState(() => league?.config?.keeper_cost_inflation_pct ?? 20);
const [taxiSquadSize, setTaxiSquadSize] = useState(() => league?.config?.taxi_squad_size ?? 3);
const [seasonMsg, setSeasonMsg] = useState('');
const [keeperReadiness, setKeeperReadiness] = useState(null);
```

- [ ] **Step 3: Add useEffect to load keeper readiness when phase is keeper_window**

After the existing auction session useEffect, add:

```js
useEffect(() => {
  if (league?.phase === 'keeper_window') {
    api.leagues.keepers.get(leagueId).then(d => setKeeperReadiness(d)).catch(() => {});
  }
}, [leagueId, league?.phase]);
```

- [ ] **Step 4: Add season management handler functions**

After the existing `saveAuctionConfig` function, add:

```js
async function saveSeasonSettings() {
  setSeasonMsg('');
  try {
    await api.leagues.update(leagueId, {
      league_format: leagueFormat,
      config: {
        max_keepers: parseInt(maxKeepers),
        keeper_cost_type: keeperCostType,
        keeper_cost_inflation_pct: parseInt(keeperInflationPct),
        taxi_squad_size: parseInt(taxiSquadSize),
      },
    });
    await refreshLeague();
    setSeasonMsg('Settings saved.');
  } catch (e) { setSeasonMsg(e.message); }
}

async function endSeason() {
  if (!window.confirm('End the current season? This will snapshot all rosters.')) return;
  try {
    await api.leagues.season.end(leagueId);
    await refreshLeague();
    setSeasonMsg('Season ended.');
  } catch (e) { setSeasonMsg(e.message); }
}

async function openKeeperWindow() {
  try {
    await api.leagues.season.openKeeperWindow(leagueId);
    await refreshLeague();
    setSeasonMsg('Keeper window opened.');
  } catch (e) { setSeasonMsg(e.message); }
}

async function closeKeeperWindow() {
  if (!window.confirm('Close the keeper window? Non-keepers will be removed from all rosters.')) return;
  try {
    const data = await api.leagues.season.closeKeeperWindow(leagueId);
    await refreshLeague();
    setSeasonMsg(`Keeper window closed. Season advanced to ${data.nextSeason}.`);
  } catch (e) { setSeasonMsg(e.message); }
}

async function startNewSeason() {
  if (!window.confirm('Start a new season? This will advance the season string.')) return;
  try {
    const data = await api.leagues.season.start(leagueId);
    await refreshLeague();
    setSeasonMsg(`New season started (${data.nextSeason}). Phase: ${data.phase}.`);
  } catch (e) { setSeasonMsg(e.message); }
}

async function activateSeason() {
  try {
    await api.leagues.season.activate(leagueId);
    await refreshLeague();
    setSeasonMsg('Season activated!');
  } catch (e) { setSeasonMsg(e.message); }
}
```

- [ ] **Step 5: Add Season Management JSX card**

After the Auction Setup card closing `</div>`, add:

```jsx
<div className="card" style={{ marginTop: '1.5rem' }}>
  <h3 style={{ marginTop: 0 }}>Season Management</h3>

  <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem', alignItems: 'flex-end' }}>
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: '0.8rem', color: '#888' }}>League Format</span>
      <select value={leagueFormat} onChange={e => setLeagueFormat(e.target.value)}>
        <option value="redraft">Redraft</option>
        <option value="keeper">Keeper</option>
        <option value="dynasty">Dynasty</option>
      </select>
    </label>

    {leagueFormat === 'keeper' && (
      <>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: '0.8rem', color: '#888' }}>Max Keepers</span>
          <input type="number" min={1} max={18} value={maxKeepers} onChange={e => setMaxKeepers(e.target.value)} style={{ width: 70 }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: '0.8rem', color: '#888' }}>Keeper Cost</span>
          <select value={keeperCostType} onChange={e => setKeeperCostType(e.target.value)}>
            <option value="free">Free</option>
            <option value="pick_round">Draft Round</option>
            <option value="auction_inflation">Auction Inflation %</option>
            <option value="none">Manual (no enforcement)</option>
          </select>
        </label>
        {keeperCostType === 'auction_inflation' && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: '0.8rem', color: '#888' }}>Inflation %</span>
            <input type="number" min={0} max={200} value={keeperInflationPct} onChange={e => setKeeperInflationPct(e.target.value)} style={{ width: 70 }} />
          </label>
        )}
      </>
    )}

    {leagueFormat === 'dynasty' && (
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: '0.8rem', color: '#888' }}>Taxi Squad Size</span>
        <input type="number" min={0} max={10} value={taxiSquadSize} onChange={e => setTaxiSquadSize(e.target.value)} style={{ width: 70 }} />
      </label>
    )}

    <button onClick={saveSeasonSettings}>Save Settings</button>
  </div>

  <div style={{ borderTop: '1px solid #333', paddingTop: '1rem' }}>
    <div style={{ fontSize: '0.8rem', color: '#888', marginBottom: '0.5rem' }}>
      Current phase: <strong>{league?.phase ?? 'active'}</strong> · Season: <strong>{league?.season}</strong>
    </div>

    {league?.phase === 'active' && (
      <button onClick={endSeason} style={{ background: '#c0392b', border: 'none', color: '#fff', padding: '6px 14px', borderRadius: 4, cursor: 'pointer' }}>
        End Season
      </button>
    )}

    {league?.phase === 'offseason' && league?.league_format === 'keeper' && (
      <button onClick={openKeeperWindow}>Open Keeper Window</button>
    )}

    {league?.phase === 'keeper_window' && (
      <div>
        {keeperReadiness && (
          <div style={{ marginBottom: '0.75rem' }}>
            {keeperReadiness.teams.map(t => (
              <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', padding: '3px 0', borderBottom: '1px solid #222' }}>
                <span>{t.name}</span>
                <span style={{ color: t.designationCount === keeperReadiness.config.maxKeepers ? '#27ae60' : '#888' }}>
                  {t.designationCount} / {keeperReadiness.config.maxKeepers}
                </span>
              </div>
            ))}
          </div>
        )}
        <button onClick={closeKeeperWindow}>Close Keeper Window</button>
      </div>
    )}

    {league?.phase === 'offseason' && league?.league_format !== 'keeper' && (
      <button onClick={startNewSeason}>Start New Season</button>
    )}

    {league?.phase === 'supplemental_draft' && (
      <p style={{ color: '#888', fontSize: '0.85rem' }}>
        Supplemental draft in progress —{' '}
        <a href={`/leagues/${leagueId}/draft`} style={{ color: '#3498db' }}>Go to Draft Room</a>{' '}
        or{' '}
        <a href={`/leagues/${leagueId}/auction`} style={{ color: '#3498db' }}>Go to Auction Room</a>
      </p>
    )}

    {league?.phase === 'pre_draft' && (
      <button onClick={activateSeason}>Activate Season</button>
    )}
  </div>

  {seasonMsg && <p style={{ color: '#e67e22', marginTop: '0.5rem', fontSize: '0.85rem' }}>{seasonMsg}</p>}
</div>
```

- [ ] **Step 6: Commit**

```
git add client/src/pages/CommissionerDashboard.jsx
git commit -m "feat: CommissionerDashboard Season Management — format selector, keeper config, phase-action buttons"
```
