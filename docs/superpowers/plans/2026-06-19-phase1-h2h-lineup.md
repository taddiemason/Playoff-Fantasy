# Phase 1 — H2H Matchups + Active Lineup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add weekly head-to-head matchups and active/bench lineup management to every league, so managers have strategic decisions to make each week and compete head-to-head instead of in a pure points standings.

**Architecture:** New DB tables (`matchup_periods`, `matchups`, `active_roster`) are additive. The commissioner generates a round-robin schedule; matchup scores are computed by filtering the existing per-player fantasy-points pipeline to each team's active players. Standings gain a W/L/T record. Three new React pages (Schedule, Lineup, Matchup) slot into the existing `LeagueLayout` nested-route structure.

**Tech Stack:** Cloudflare Workers (D1 SQL), React 18 + React Router v6, Vite, vanilla CSS.

## Global Constraints

- All DB changes must be in a new migration file `migrations/0011_matchup_periods.sql` — additive only, no drops or renames of existing columns.
- Worker routing follows the existing `if (pathnameMatch && method)` pattern inside `handleApi` in `worker/index.js`.
- D1 queries use `db.prepare(sql).bind(...args).first()` / `.all()` / `.run()`.
- All new API responses use the `json(data, {status?})` helper already defined in `worker/index.js`.
- Auth context for league endpoints uses the existing `loadLeagueContext(db, request, leagueId)` helper — returns `{user, league, role, error}`.
- Commissioner-only endpoints check `isCommissioner(ctx.league, ctx.role, ctx.user.id)`.
- Frontend API calls go through the `api` object in `client/src/api.js` using the existing `request()` / `mutate()` helpers.
- New React pages live in `client/src/pages/`. New routes nest inside the existing `/leagues/:leagueId` `LeagueLayout` in `client/src/App.jsx`.
- No new npm dependencies.

---

## File Map

| File | Action | What changes |
|------|--------|--------------|
| `migrations/0011_matchup_periods.sql` | Create | Three new tables + waiver_priority col |
| `worker/index.js` | Modify | `DEFAULT_LEAGUE_CONFIG` defaults, 4 helper functions, 6 new endpoints, updated cron |
| `client/src/api.js` | Modify | `schedule`, `lineup`, `matchup` method groups added to `api.leagues` |
| `client/src/App.jsx` | Modify | Three new nested routes |
| `client/src/pages/Standings.jsx` | Modify | W/L/T columns added to table |
| `client/src/pages/CommissionerDashboard.jsx` | Modify | Schedule generation form section |
| `client/src/pages/SchedulePage.jsx` | Create | Full season schedule grid |
| `client/src/pages/LineupPage.jsx` | Create | Active/bench toggle per player per period |
| `client/src/pages/MatchupPage.jsx` | Create | Current week H2H score vs opponent |

---

## Task 1: Database Migration

**Files:**
- Create: `migrations/0011_matchup_periods.sql`

**Interfaces:**
- Produces: `matchup_periods(id, league_id, period_num, start_date, end_date, lock_time)`, `matchups(id, league_id, period_id, home_team_id, away_team_id, home_score, away_score, winner_team_id)`, `active_roster(team_id, player_id, period_id, is_active)`, `waiver_priority` column on `league_members`.

- [ ] **Step 1: Write the migration file**

```sql
-- migrations/0011_matchup_periods.sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS matchup_periods (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id   INTEGER NOT NULL,
  period_num  INTEGER NOT NULL,
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  lock_time   DATETIME,
  FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE,
  UNIQUE(league_id, period_num)
);

CREATE TABLE IF NOT EXISTS matchups (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id       INTEGER NOT NULL,
  period_id       INTEGER NOT NULL,
  home_team_id    INTEGER NOT NULL,
  away_team_id    INTEGER NOT NULL,
  home_score      REAL NOT NULL DEFAULT 0,
  away_score      REAL NOT NULL DEFAULT 0,
  winner_team_id  INTEGER,
  FOREIGN KEY (league_id)     REFERENCES leagues(id) ON DELETE CASCADE,
  FOREIGN KEY (period_id)     REFERENCES matchup_periods(id) ON DELETE CASCADE,
  FOREIGN KEY (home_team_id)  REFERENCES teams(id),
  FOREIGN KEY (away_team_id)  REFERENCES teams(id)
);

CREATE INDEX IF NOT EXISTS idx_matchups_league_period ON matchups(league_id, period_id);

CREATE TABLE IF NOT EXISTS active_roster (
  team_id    INTEGER NOT NULL,
  player_id  INTEGER NOT NULL,
  period_id  INTEGER NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (team_id, player_id, period_id),
  FOREIGN KEY (team_id)   REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (period_id) REFERENCES matchup_periods(id) ON DELETE CASCADE
);

ALTER TABLE league_members ADD COLUMN waiver_priority INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Apply migration against local D1**

```bash
npx wrangler d1 execute playoff-fantasy --local --file=migrations/0011_matchup_periods.sql
```

Expected output: `Successfully executed` with no errors. If D1 database name differs, check `wrangler.toml` for the `database_name` value.

- [ ] **Step 3: Verify tables exist**

```bash
npx wrangler d1 execute playoff-fantasy --local --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

Expected: `active_roster`, `matchup_periods`, `matchups` appear in the list alongside existing tables.

- [ ] **Step 4: Commit**

```bash
git add migrations/0011_matchup_periods.sql
git commit -m "feat: add matchup_periods, matchups, active_roster tables (migration 0011)"
```

---

## Task 2: Worker — Config Defaults + Schedule Helpers

**Files:**
- Modify: `worker/index.js` (around line 226 `DEFAULT_LEAGUE_CONFIG`, and just above `handleApi` at line 464)

**Interfaces:**
- Produces: `getActiveSlots(config)` → `{F: number, D: number, G: number}`, `generateRoundRobin(teams, startDate, numWeeks, lockHourUtc)` → `[{period_num, start_date, end_date, lock_time, matchups: [{home_team_id, away_team_id}]}]`, `getTeamRecords(db, leagueId)` → `Map<teamId, {wins, losses, ties}>`, `getCurrentPeriod(db, leagueId)` → period row or null.

- [ ] **Step 1: Add active_slots defaults to DEFAULT_LEAGUE_CONFIG**

Find `DEFAULT_LEAGUE_CONFIG` at line ~226 in `worker/index.js`. It currently ends with `commissionerNotes: ''`. Add two new keys before the closing `}`:

```js
const DEFAULT_LEAGUE_CONFIG = {
  scoring: {
    skater: { goal: 2, assist: 1, specialTeamsPointBonus: 1, pim: 0.5 },
    goalie: { win: 2, shutout: 3, gaaRank: true, svpRank: true },
  },
  roster: { maxF: 10, maxD: 5, maxG: 3, maxSameTeamF: 3, maxSameTeamD: 2 },
  active_slots: { F: 6, D: 3, G: 2 },
  lineup_lock_hour_utc: 23,
  lock: { lockedAt: null, rule: 'Before puck drop of Game 1' },
  payout: [
    { minEntries: 0, split: 'Winner takes all' },
    { minEntries: 7, split: '75% to 1st · 25% to 2nd' },
    { minEntries: 12, split: '60% to 1st · 25% to 2nd · 15% to 3rd' },
  ],
  tiebreaker: { type: 'cupGoalieSavePct' },
  description: '',
  commissionerNotes: '',
};
```

Also update `mergeConfig` to spread `active_slots` and `lineup_lock_hour_utc`:

```js
function mergeConfig(stored) {
  let parsed = {};
  if (stored) {
    try { parsed = typeof stored === 'string' ? JSON.parse(stored) : stored; } catch { parsed = {}; }
  }
  const d = DEFAULT_LEAGUE_CONFIG;
  return {
    ...d,
    ...parsed,
    scoring: {
      skater: { ...d.scoring.skater, ...(parsed.scoring?.skater) },
      goalie: { ...d.scoring.goalie, ...(parsed.scoring?.goalie) },
    },
    roster: { ...d.roster, ...(parsed.roster) },
    active_slots: { ...d.active_slots, ...(parsed.active_slots) },
    lineup_lock_hour_utc: parsed.lineup_lock_hour_utc ?? d.lineup_lock_hour_utc,
    lock: { ...d.lock, ...(parsed.lock) },
    payout: Array.isArray(parsed.payout) ? parsed.payout : d.payout,
    tiebreaker: { ...d.tiebreaker, ...(parsed.tiebreaker) },
  };
}
```

- [ ] **Step 2: Add four helper functions just above `handleApi`**

Insert the following block immediately before the line `async function handleApi(request, env, pathname) {` (around line 464):

```js
// ── Schedule & matchup helpers ──────────────────────────────────────────────

function getActiveSlots(config) {
  return { F: config.active_slots?.F ?? 6, D: config.active_slots?.D ?? 3, G: config.active_slots?.G ?? 2 };
}

function generateRoundRobin(teams, startDate, numWeeks, lockHourUtc = 23) {
  const slots = [...teams];
  if (slots.length % 2 !== 0) slots.push(null); // null = bye
  const n = slots.length;
  const periods = [];
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const base = new Date(startDate + 'T00:00:00Z');

  for (let week = 0; week < numWeeks; week++) {
    const periodStart = new Date(base.getTime() + week * msPerWeek);
    const periodEnd = new Date(base.getTime() + (week + 1) * msPerWeek - 1);
    const lockDate = new Date(periodStart);
    lockDate.setUTCHours(lockHourUtc, 0, 0, 0);

    const pairings = [];
    for (let i = 0; i < n / 2; i++) {
      const home = slots[i];
      const away = slots[n - 1 - i];
      if (home !== null && away !== null) {
        pairings.push({ home_team_id: home.id, away_team_id: away.id });
      }
    }

    periods.push({
      period_num: week + 1,
      start_date: periodStart.toISOString().slice(0, 10),
      end_date: periodEnd.toISOString().slice(0, 10),
      lock_time: lockDate.toISOString(),
      matchups: pairings,
    });

    // Rotate: keep slots[0] fixed, rotate slots[1..]
    const last = slots[n - 1];
    for (let i = n - 1; i > 1; i--) slots[i] = slots[i - 1];
    slots[1] = last;
  }

  return periods;
}

async function getTeamRecords(db, leagueId) {
  const { results } = await db.prepare(`
    SELECT team_id,
      SUM(CASE WHEN result = 'W' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN result = 'L' THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN result = 'T' THEN 1 ELSE 0 END) AS ties
    FROM (
      SELECT home_team_id AS team_id,
        CASE
          WHEN home_score > away_score THEN 'W'
          WHEN home_score < away_score THEN 'L'
          ELSE 'T'
        END AS result
      FROM matchups
      WHERE league_id = ? AND (winner_team_id IS NOT NULL OR home_score > 0 OR away_score > 0)
      UNION ALL
      SELECT away_team_id,
        CASE
          WHEN away_score > home_score THEN 'W'
          WHEN away_score < home_score THEN 'L'
          ELSE 'T'
        END AS result
      FROM matchups
      WHERE league_id = ? AND (winner_team_id IS NOT NULL OR home_score > 0 OR away_score > 0)
    ) sub
    GROUP BY team_id
  `).bind(leagueId, leagueId).all();

  const map = new Map();
  for (const row of (results || [])) {
    map.set(row.team_id, { wins: row.wins ?? 0, losses: row.losses ?? 0, ties: row.ties ?? 0 });
  }
  return map;
}

async function getCurrentPeriod(db, leagueId) {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare(
    `SELECT * FROM matchup_periods WHERE league_id = ? AND start_date <= ? AND end_date >= ? LIMIT 1`
  ).bind(leagueId, today, today).first();
}
```

- [ ] **Step 3: Verify the worker still starts**

```bash
npm run dev
```

Expected: dev server starts without syntax errors. If an error appears, check that the `mergeConfig` closing brace is balanced.

- [ ] **Step 4: Commit**

```bash
git add worker/index.js
git commit -m "feat: add active_slots config defaults and schedule/matchup helper functions"
```

---

## Task 3: Worker — Schedule Generate + Get Endpoints

**Files:**
- Modify: `worker/index.js` inside `handleApi`, after the existing league PATCH handler (~line 742)

**Interfaces:**
- Consumes: `generateRoundRobin()`, `loadLeagueContext()`, `isCommissioner()`, `getLeagueTeams()`
- Produces: `POST /api/leagues/:id/schedule/generate` → `{periods: [...]}`, `GET /api/leagues/:id/schedule` → `{periods: [...], matchups: [...]}`

- [ ] **Step 1: Add the two schedule endpoints inside handleApi**

Find the comment `// League-scoped teams` at line ~744 in `worker/index.js`. Insert the following block immediately before it:

```js
  // ── Schedule ──────────────────────────────────────────────────────────────
  const scheduleMatch = pathname.match(/^\/api\/leagues\/(\d+)\/schedule$/);
  if (scheduleMatch && request.method === 'GET') {
    const leagueId = parseId(scheduleMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    const { results: periods } = await db
      .prepare('SELECT * FROM matchup_periods WHERE league_id = ? ORDER BY period_num')
      .bind(leagueId).all();
    const { results: matchups } = await db
      .prepare(`SELECT m.*, t1.name AS home_name, t2.name AS away_name
                FROM matchups m
                JOIN teams t1 ON t1.id = m.home_team_id
                JOIN teams t2 ON t2.id = m.away_team_id
                WHERE m.league_id = ? ORDER BY m.period_id, m.id`)
      .bind(leagueId).all();
    return json({ periods: periods || [], matchups: matchups || [] });
  }

  const scheduleGenMatch = pathname.match(/^\/api\/leagues\/(\d+)\/schedule\/generate$/);
  if (scheduleGenMatch && request.method === 'POST') {
    const leagueId = parseId(scheduleGenMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id)) return json({ error: 'Commissioner only' }, { status: 403 });
    const { start_date, num_weeks } = await request.json();
    if (!start_date || !num_weeks || num_weeks < 1 || num_weeks > 52) {
      return json({ error: 'start_date and num_weeks (1–52) are required' }, { status: 400 });
    }
    const teams = await getLeagueTeams(db, leagueId);
    if (teams.length < 2) return json({ error: 'League needs at least 2 teams' }, { status: 400 });

    const cfg = mergeConfig(ctx.league.config_json);
    const periods = generateRoundRobin(teams, start_date, num_weeks, cfg.lineup_lock_hour_utc);

    // Wipe existing schedule then insert fresh
    await db.prepare('DELETE FROM matchup_periods WHERE league_id = ?').bind(leagueId).run();

    for (const p of periods) {
      const period = await db
        .prepare(`INSERT INTO matchup_periods (league_id, period_num, start_date, end_date, lock_time)
                  VALUES (?, ?, ?, ?, ?) RETURNING *`)
        .bind(leagueId, p.period_num, p.start_date, p.end_date, p.lock_time)
        .first();
      for (const m of p.matchups) {
        await db
          .prepare(`INSERT INTO matchups (league_id, period_id, home_team_id, away_team_id)
                    VALUES (?, ?, ?, ?)`)
          .bind(leagueId, period.id, m.home_team_id, m.away_team_id)
          .run();
      }
    }

    const { results: allPeriods } = await db
      .prepare('SELECT * FROM matchup_periods WHERE league_id = ? ORDER BY period_num')
      .bind(leagueId).all();
    return json({ periods: allPeriods || [] });
  }
```

- [ ] **Step 2: Start the dev server and test schedule generation**

```bash
npm run dev
```

In a second terminal (replace TOKEN with a valid session cookie from logging in via the browser):

```bash
# Generate a 4-week schedule for league 1 (adjust IDs as needed)
curl -s -X POST http://localhost:3001/api/leagues/1/schedule/generate \
  -H "Content-Type: application/json" \
  -H "Cookie: session=TOKEN" \
  -d '{"start_date":"2026-07-07","num_weeks":4}' | jq .
```

Expected: `{"periods": [...]}` with 4 period objects. Each period has `id`, `period_num`, `start_date`, `end_date`, `lock_time`.

```bash
# Fetch the schedule back
curl -s http://localhost:3001/api/leagues/1/schedule \
  -H "Cookie: session=TOKEN" | jq '.periods | length'
```

Expected: `4`

- [ ] **Step 3: Commit**

```bash
git add worker/index.js
git commit -m "feat: add schedule generate and get endpoints"
```

---

## Task 4: Worker — Lineup Endpoints

**Files:**
- Modify: `worker/index.js` inside `handleApi`, after the schedule endpoints added in Task 3

**Interfaces:**
- Consumes: `getActiveSlots()`, `getCurrentPeriod()`
- Produces: `GET /api/leagues/:id/teams/:teamId/lineup/:periodId` → `{active: [player], bench: [player], slots: {F,D,G}, locked: bool}`, `PUT /api/leagues/:id/teams/:teamId/lineup/:periodId` → `{success: true}`

- [ ] **Step 1: Add lineup endpoints inside handleApi**

Insert the following block immediately after the schedule endpoints (after the closing brace of the `scheduleGenMatch` block):

```js
  // ── Lineup ────────────────────────────────────────────────────────────────
  const lineupMatch = pathname.match(/^\/api\/leagues\/(\d+)\/teams\/(\d+)\/lineup\/(\d+)$/);
  if (lineupMatch && request.method === 'GET') {
    const leagueId = parseId(lineupMatch[1]);
    const teamId   = parseId(lineupMatch[2]);
    const periodId = parseId(lineupMatch[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;

    const period = await db.prepare('SELECT * FROM matchup_periods WHERE id = ? AND league_id = ?')
      .bind(periodId, leagueId).first();
    if (!period) return json({ error: 'Period not found' }, { status: 404 });

    const cfg = mergeConfig(ctx.league.config_json);
    const slots = getActiveSlots(cfg);
    const locked = period.lock_time ? new Date(period.lock_time).getTime() <= Date.now() : false;

    const players = await getTeamPlayers(db, teamId);
    const { results: arRows } = await db
      .prepare('SELECT player_id, is_active FROM active_roster WHERE team_id = ? AND period_id = ?')
      .bind(teamId, periodId).all();

    let activeMap;
    if (arRows && arRows.length > 0) {
      activeMap = new Map(arRows.map(r => [r.player_id, !!r.is_active]));
    } else {
      // Auto-seed: first N players per position are active
      const countByPos = { F: 0, D: 0, G: 0 };
      activeMap = new Map(players.map(p => {
        const pos = mapPosition(p.position);
        const limit = slots[pos] ?? 0;
        const active = countByPos[pos] < limit;
        countByPos[pos]++;
        return [p.player_id, active];
      }));
    }

    const active = players.filter(p => activeMap.get(p.player_id));
    const bench  = players.filter(p => !activeMap.get(p.player_id));
    return json({ active, bench, slots, locked });
  }

  if (lineupMatch && request.method === 'PUT') {
    const leagueId = parseId(lineupMatch[1]);
    const teamId   = parseId(lineupMatch[2]);
    const periodId = parseId(lineupMatch[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;

    const team = await db.prepare('SELECT * FROM teams WHERE id = ? AND league_id = ?')
      .bind(teamId, leagueId).first();
    if (!team) return json({ error: 'Team not found' }, { status: 404 });
    if (team.user_id !== ctx.user.id && !isCommissioner(ctx.league, ctx.role, ctx.user.id)) {
      return json({ error: 'You can only set your own lineup' }, { status: 403 });
    }

    const period = await db.prepare('SELECT * FROM matchup_periods WHERE id = ? AND league_id = ?')
      .bind(periodId, leagueId).first();
    if (!period) return json({ error: 'Period not found' }, { status: 404 });
    if (period.lock_time && new Date(period.lock_time).getTime() <= Date.now()) {
      return json({ error: 'Lineup is locked for this period' }, { status: 400 });
    }

    const { active_player_ids } = await request.json(); // array of player_id integers
    if (!Array.isArray(active_player_ids)) {
      return json({ error: 'active_player_ids must be an array' }, { status: 400 });
    }

    const cfg = mergeConfig(ctx.league.config_json);
    const slots = getActiveSlots(cfg);
    const players = await getTeamPlayers(db, teamId);
    const playerMap = new Map(players.map(p => [p.player_id, p]));
    const activeSet = new Set(active_player_ids.map(Number));

    // Validate slot limits
    const countByPos = { F: 0, D: 0, G: 0 };
    for (const pid of activeSet) {
      const p = playerMap.get(pid);
      if (!p) return json({ error: `Player ${pid} not on this team` }, { status: 400 });
      const pos = mapPosition(p.position);
      countByPos[pos]++;
    }
    for (const [pos, count] of Object.entries(countByPos)) {
      if (count > (slots[pos] ?? 0)) {
        return json({ error: `Too many active ${pos} (max ${slots[pos]})` }, { status: 400 });
      }
    }

    // Upsert all players
    for (const p of players) {
      const isActive = activeSet.has(p.player_id) ? 1 : 0;
      await db.prepare(`
        INSERT INTO active_roster (team_id, player_id, period_id, is_active)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(team_id, player_id, period_id) DO UPDATE SET is_active = excluded.is_active
      `).bind(teamId, p.player_id, periodId, isActive).run();
    }

    return json({ success: true });
  }
```

- [ ] **Step 2: Test lineup GET (auto-seed) and PUT**

```bash
# GET lineup — should return auto-seeded active/bench split
curl -s "http://localhost:3001/api/leagues/1/teams/1/lineup/1" \
  -H "Cookie: session=TOKEN" | jq '{active: (.active | length), bench: (.bench | length), locked: .locked}'
```

Expected: `{"active": N, "bench": M, "locked": false}` where N ≤ sum of active slots.

```bash
# PUT lineup — set specific players active (replace 101,102,103 with real player_ids from your team)
curl -s -X PUT "http://localhost:3001/api/leagues/1/teams/1/lineup/1" \
  -H "Content-Type: application/json" \
  -H "Cookie: session=TOKEN" \
  -d '{"active_player_ids":[101,102,103]}' | jq .
```

Expected: `{"success":true}`

- [ ] **Step 3: Commit**

```bash
git add worker/index.js
git commit -m "feat: add lineup GET/PUT endpoints with auto-seed and lock-time enforcement"
```

---

## Task 5: Worker — Matchup Scoring Endpoint + Cron Update

**Files:**
- Modify: `worker/index.js` inside `handleApi` (new endpoints) and the `scheduled` handler at the bottom

**Interfaces:**
- Consumes: `computeStandings()`, `getCurrentPeriod()`, `getTeamRecords()`
- Produces: `GET /api/leagues/:id/matchups/current` → `{period, matchup, myScore, oppScore, myTeam, oppTeam}`, `GET /api/leagues/:id/matchups/:periodId` → `{period, matchups: [...]}`, `POST /api/leagues/:id/matchups/score` → `{scored: number}`, cron also scores matchups on hourly tick.

- [ ] **Step 1: Add scoreMatchupsForLeague helper just above handleApi**

Add this function in the helpers block created in Task 2 (append after `getCurrentPeriod`):

```js
async function scoreMatchupsForLeague(db, leagueId, league) {
  const period = await getCurrentPeriod(db, leagueId);
  if (!period) return 0;

  const { matchups } = await (async () => {
    const { results } = await db
      .prepare('SELECT * FROM matchups WHERE period_id = ?')
      .bind(period.id).all();
    return { matchups: results || [] };
  })();

  if (matchups.length === 0) return 0;

  const standings = await computeStandings(db, {
    leagueId,
    season: league.season,
    seasonType: league.season_type || 'playoffs',
    config: mergeConfig(league.config_json),
  });

  // Build a map of team_id → {player_id → points}
  const teamPlayerPoints = new Map();
  for (const team of (standings.standings || [])) {
    const playerPts = new Map();
    for (const p of (team.players || [])) {
      playerPts.set(p.player_id, p.points ?? 0);
    }
    teamPlayerPoints.set(team.id, playerPts);
  }

  let scored = 0;
  for (const matchup of matchups) {
    const calcScore = async (teamId) => {
      const { results: arRows } = await db
        .prepare('SELECT player_id, is_active FROM active_roster WHERE team_id = ? AND period_id = ?')
        .bind(teamId, period.id).all();

      const playerPts = teamPlayerPoints.get(teamId) || new Map();

      if (!arRows || arRows.length === 0) {
        // No lineup set — sum all players
        let total = 0;
        for (const pts of playerPts.values()) total += pts;
        return total;
      }

      let total = 0;
      for (const row of arRows) {
        if (row.is_active) total += playerPts.get(row.player_id) ?? 0;
      }
      return total;
    };

    const homeScore = await calcScore(matchup.home_team_id);
    const awayScore = await calcScore(matchup.away_team_id);
    const winnerId = homeScore > awayScore
      ? matchup.home_team_id
      : awayScore > homeScore
        ? matchup.away_team_id
        : null;

    await db.prepare(`
      UPDATE matchups SET home_score = ?, away_score = ?, winner_team_id = ?
      WHERE id = ?
    `).bind(homeScore, awayScore, winnerId, matchup.id).run();
    scored++;
  }

  return scored;
}
```

- [ ] **Step 2: Add matchup GET endpoints inside handleApi**

Insert immediately after the lineup endpoints added in Task 4:

```js
  // ── Matchups ──────────────────────────────────────────────────────────────
  const matchupCurrentMatch = pathname.match(/^\/api\/leagues\/(\d+)\/matchups\/current$/);
  if (matchupCurrentMatch && request.method === 'GET') {
    const leagueId = parseId(matchupCurrentMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;

    const period = await getCurrentPeriod(db, leagueId);
    if (!period) return json({ period: null, matchup: null });

    const myTeam = await db
      .prepare('SELECT * FROM teams WHERE league_id = ? AND user_id = ? LIMIT 1')
      .bind(leagueId, ctx.user.id).first();
    if (!myTeam) return json({ error: 'You have no team in this league' }, { status: 404 });

    const matchup = await db.prepare(`
      SELECT m.*, t1.name AS home_name, t2.name AS away_name
      FROM matchups m
      JOIN teams t1 ON t1.id = m.home_team_id
      JOIN teams t2 ON t2.id = m.away_team_id
      WHERE m.period_id = ? AND (m.home_team_id = ? OR m.away_team_id = ?)
      LIMIT 1
    `).bind(period.id, myTeam.id, myTeam.id).first();

    if (!matchup) return json({ period, matchup: null });

    const oppTeamId = matchup.home_team_id === myTeam.id ? matchup.away_team_id : matchup.home_team_id;
    const oppTeam = await db.prepare('SELECT * FROM teams WHERE id = ?').bind(oppTeamId).first();
    const oppPlayers = await getTeamPlayers(db, oppTeamId);

    return json({ period, matchup, myTeam, oppTeam, oppPlayers });
  }

  const matchupPeriodMatch = pathname.match(/^\/api\/leagues\/(\d+)\/matchups\/(\d+)$/);
  if (matchupPeriodMatch && request.method === 'GET') {
    const leagueId = parseId(matchupPeriodMatch[1]);
    const periodId = parseId(matchupPeriodMatch[2]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    const period = await db.prepare('SELECT * FROM matchup_periods WHERE id = ? AND league_id = ?')
      .bind(periodId, leagueId).first();
    if (!period) return json({ error: 'Period not found' }, { status: 404 });
    const { results: matchups } = await db.prepare(`
      SELECT m.*, t1.name AS home_name, t2.name AS away_name
      FROM matchups m
      JOIN teams t1 ON t1.id = m.home_team_id
      JOIN teams t2 ON t2.id = m.away_team_id
      WHERE m.period_id = ?
    `).bind(periodId).all();
    return json({ period, matchups: matchups || [] });
  }

  const matchupScoreMatch = pathname.match(/^\/api\/leagues\/(\d+)\/matchups\/score$/);
  if (matchupScoreMatch && request.method === 'POST') {
    const leagueId = parseId(matchupScoreMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id)) return json({ error: 'Commissioner only' }, { status: 403 });
    const scored = await scoreMatchupsForLeague(db, leagueId, ctx.league);
    return json({ scored });
  }
```

- [ ] **Step 3: Update the cron scheduled handler to score matchups**

Find the `async scheduled(_event, env, _ctx)` function near line 1620. Update it to also score matchups after computing standings:

```js
  async scheduled(_event, env, _ctx) {
    clearNhlCache();
    const db = env.DB;
    try {
      const { results } = await db.prepare('SELECT id, season, season_type, config_json FROM leagues').all();
      for (const league of (results || [])) {
        try {
          await computeStandings(db, { leagueId: league.id, season: league.season, seasonType: league.season_type || 'playoffs', config: mergeConfig(league.config_json) });
        } catch (err) {
          console.error(`[cron] league ${league.id} standings failed:`, err?.message ?? err);
        }
        try {
          await scoreMatchupsForLeague(db, league.id, league);
        } catch (err) {
          console.error(`[cron] league ${league.id} matchup scoring failed:`, err?.message ?? err);
        }
      }
    } catch (err) {
      console.error('[cron] failed to list leagues:', err?.message ?? err);
    }
    try {
      await computeStandings(db, { leagueId: null, season: getCurrentSeason(), config: DEFAULT_LEAGUE_CONFIG });
    } catch {}
  }
```

- [ ] **Step 4: Test matchup endpoints**

```bash
# Score the current period's matchups
curl -s -X POST http://localhost:3001/api/leagues/1/matchups/score \
  -H "Cookie: session=TOKEN" | jq .
```

Expected: `{"scored": 2}` (or however many matchups exist in the current period).

```bash
# Get current matchup for the authenticated user's team
curl -s http://localhost:3001/api/leagues/1/matchups/current \
  -H "Cookie: session=TOKEN" | jq '{home: .matchup.home_name, homeScore: .matchup.home_score, away: .matchup.away_name, awayScore: .matchup.away_score}'
```

Expected: both team names and numeric scores.

- [ ] **Step 5: Commit**

```bash
git add worker/index.js
git commit -m "feat: add matchup scoring endpoint, current/period matchup GETs, cron integration"
```

---

## Task 6: Worker — Standings W/L/T

**Files:**
- Modify: `worker/index.js` — the `computeStandings` function and the GET standings endpoint

**Interfaces:**
- Consumes: `getTeamRecords(db, leagueId)`
- Produces: each team in `standings` gains `wins`, `losses`, `ties` fields; standings sorted by W then total points.

- [ ] **Step 1: Merge team records into computeStandings result**

Find the line `standings.sort((a, b) => b.totalPoints - a.totalPoints);` (around line 1552 in `worker/index.js`). Replace it and the block immediately after until `const eliminatedTeams` with:

```js
      // Attach W/L/T records if the league has a schedule
      let records = new Map();
      if (leagueId != null) {
        try { records = await getTeamRecords(db, leagueId); } catch {}
      }
      for (const team of standings) {
        const r = records.get(team.id) || { wins: 0, losses: 0, ties: 0 };
        team.wins   = r.wins;
        team.losses = r.losses;
        team.ties   = r.ties;
      }

      // Sort by W/L/T record first, then total points as tiebreaker
      standings.sort((a, b) => {
        const aWin = (a.wins ?? 0) - (a.losses ?? 0);
        const bWin = (b.wins ?? 0) - (b.losses ?? 0);
        if (bWin !== aWin) return bWin - aWin;
        return b.totalPoints - a.totalPoints;
      });

      const eliminatedTeams = seasonType === 'regular' ? [] : await getEliminatedTeams(season, db);
```

- [ ] **Step 2: Verify standings response includes W/L/T**

```bash
curl -s http://localhost:3001/api/leagues/1/standings \
  -H "Cookie: session=TOKEN" | jq '.standings[0] | {name: .name, wins: .wins, losses: .losses, ties: .ties, totalPoints: .totalPoints}'
```

Expected: all four fields present. `wins`/`losses`/`ties` will be 0 until matchups are scored.

- [ ] **Step 3: Commit**

```bash
git add worker/index.js
git commit -m "feat: add W/L/T record to standings sorted by record then total points"
```

---

## Task 7: API Client + Routes

**Files:**
- Modify: `client/src/api.js`
- Modify: `client/src/App.jsx`

**Interfaces:**
- Produces: `api.leagues.schedule.*`, `api.leagues.lineup.*`, `api.leagues.matchup.*` methods; three new routes at `/leagues/:leagueId/schedule`, `/lineup`, `/matchup`.

- [ ] **Step 1: Add new method groups to api.leagues in client/src/api.js**

Find `// Commissioner` inside the `leagues` object (around line 130). Add the following three groups before the closing `}` of the `leagues` object:

```js
    // Schedule
    schedule: {
      get:      (id) => request(`/api/leagues/${id}/schedule`),
      generate: (id, startDate, numWeeks) => request(`/api/leagues/${id}/schedule/generate`, {
        method: 'POST', body: JSON.stringify({ start_date: startDate, num_weeks: numWeeks })
      }),
    },

    // Lineup
    lineup: {
      get: (id, teamId, periodId) => request(`/api/leagues/${id}/teams/${teamId}/lineup/${periodId}`),
      set: (id, teamId, periodId, activePlayerIds) => request(`/api/leagues/${id}/teams/${teamId}/lineup/${periodId}`, {
        method: 'PUT', body: JSON.stringify({ active_player_ids: activePlayerIds })
      }),
    },

    // Matchups
    matchup: {
      current:  (id) => request(`/api/leagues/${id}/matchups/current`),
      byPeriod: (id, periodId) => request(`/api/leagues/${id}/matchups/${periodId}`),
      score:    (id) => request(`/api/leagues/${id}/matchups/score`, { method: 'POST' }),
    },
```

- [ ] **Step 2: Add three new routes to App.jsx**

Add imports at the top of `client/src/App.jsx`:

```jsx
import SchedulePage from './pages/SchedulePage.jsx'
import LineupPage   from './pages/LineupPage.jsx'
import MatchupPage  from './pages/MatchupPage.jsx'
```

Inside the `<Route path="/leagues/:leagueId" element={<LeagueLayout />}>` block, add after the existing `teams/:teamId` route:

```jsx
            <Route path="schedule" element={<SchedulePage />} />
            <Route path="lineup"   element={<LineupPage />} />
            <Route path="matchup"  element={<MatchupPage />} />
```

- [ ] **Step 3: Verify no import errors**

```bash
npm run dev
```

Expected: dev server starts. Browser at `http://localhost:5173/leagues/1/schedule` should show a blank page (components not yet created) or a React error boundary — not a 500.

- [ ] **Step 4: Commit**

```bash
git add client/src/api.js client/src/App.jsx
git commit -m "feat: add schedule/lineup/matchup API methods and routes"
```

---

## Task 8: Commissioner Schedule Generation UI

**Files:**
- Modify: `client/src/pages/CommissionerDashboard.jsx`

**Interfaces:**
- Consumes: `api.leagues.schedule.generate()`, `api.leagues.matchup.score()`

- [ ] **Step 1: Add schedule generation state and handler**

At the top of `CommissionerDashboard`, add new state variables after the existing invite state:

```jsx
  const [schedStartDate, setSchedStartDate] = useState('')
  const [schedWeeks, setSchedWeeks]         = useState(10)
  const [schedMsg, setSchedMsg]             = useState(null)
  const [scheduling, setScheduling]         = useState(false)
```

Add the handler function after the existing `saveSettings` function:

```jsx
  async function generateSchedule(e) {
    e.preventDefault()
    if (!schedStartDate || !schedWeeks) return
    setScheduling(true)
    setSchedMsg(null)
    try {
      const result = await api.leagues.schedule.generate(leagueId, schedStartDate, Number(schedWeeks))
      setSchedMsg({ type: 'success', text: `Schedule created: ${result.periods.length} weeks` })
    } catch (err) {
      setSchedMsg({ type: 'error', text: err.message })
    } finally {
      setScheduling(false)
    }
  }
```

- [ ] **Step 2: Add the schedule section to the JSX**

Find the return statement in `CommissionerDashboard`. Add a new section before the closing wrapper div, after the existing invite section. Paste the following JSX block:

```jsx
      {/* ── Schedule Generation ── */}
      <section className="card" style={{ marginTop: '2rem' }}>
        <h2 className="section-title">Season Schedule</h2>
        <form onSubmit={generateSchedule} className="form-stack">
          <div className="form-row">
            <label className="form-label">Start Date</label>
            <input
              type="date"
              className="input"
              value={schedStartDate}
              onChange={e => setSchedStartDate(e.target.value)}
              required
            />
          </div>
          <div className="form-row">
            <label className="form-label">Number of Weeks</label>
            <input
              type="number"
              className="input"
              min={1}
              max={52}
              value={schedWeeks}
              onChange={e => setSchedWeeks(e.target.value)}
              required
            />
          </div>
          {schedMsg && (
            <div className={`alert alert-${schedMsg.type === 'success' ? 'success' : 'error'}`}>
              {schedMsg.text}
            </div>
          )}
          <button type="submit" className="btn btn-primary" disabled={scheduling}>
            {scheduling ? 'Generating…' : 'Generate Schedule'}
          </button>
          <p className="hint">Regenerating overwrites the existing schedule.</p>
        </form>
      </section>
```

- [ ] **Step 3: Test in browser**

With `npm run dev` running, go to `http://localhost:5173/leagues/1/admin`. Scroll to the Schedule section. Enter a start date and 4 weeks. Click "Generate Schedule". Expect the success message "Schedule created: 4 weeks".

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/CommissionerDashboard.jsx
git commit -m "feat: add schedule generation form to commissioner dashboard"
```

---

## Task 9: SchedulePage

**Files:**
- Create: `client/src/pages/SchedulePage.jsx`

**Interfaces:**
- Consumes: `api.leagues.schedule.get()`, `useOutletContext()` → `{league}`

- [ ] **Step 1: Create the file**

```jsx
// client/src/pages/SchedulePage.jsx
import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api } from '../api.js'

export default function SchedulePage() {
  const { leagueId } = useParams()
  const [data, setData]     = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState('')

  useEffect(() => {
    api.leagues.schedule.get(leagueId)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [leagueId])

  if (loading) return <div className="loading-state"><span className="loading-spinner" /> Loading schedule…</div>
  if (error)   return <div className="alert alert-error">{error}</div>
  if (!data?.periods?.length) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
        <p>No schedule yet.</p>
        <p><Link to={`/leagues/${leagueId}/admin`}>Commissioners can generate one here.</Link></p>
      </div>
    )
  }

  const matchupsByPeriod = new Map()
  for (const m of (data.matchups || [])) {
    const list = matchupsByPeriod.get(m.period_id) || []
    list.push(m)
    matchupsByPeriod.set(m.period_id, list)
  }

  return (
    <div>
      <h1 className="page-title">Schedule</h1>
      {data.periods.map(period => (
        <div key={period.id} className="card" style={{ marginBottom: '1rem' }}>
          <h3 style={{ margin: '0 0 0.5rem' }}>
            Week {period.period_num}
            <span className="badge" style={{ marginLeft: '0.5rem', fontSize: '0.75rem' }}>
              {period.start_date} – {period.end_date}
            </span>
          </h3>
          {(matchupsByPeriod.get(period.id) || []).map(m => (
            <div key={m.id} className="matchup-row" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.4rem 0', borderTop: '1px solid var(--border)' }}>
              <span style={{ flex: 1, textAlign: 'right' }}>{m.home_name}</span>
              <span style={{ fontWeight: 700, color: 'var(--accent)' }}>
                {m.home_score.toFixed(1)} – {m.away_score.toFixed(1)}
              </span>
              <span style={{ flex: 1 }}>{m.away_name}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Test in browser**

Go to `http://localhost:5173/leagues/1/schedule`. Expect a list of weeks, each showing matchups with scores (0.0 – 0.0 until scored).

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/SchedulePage.jsx
git commit -m "feat: add SchedulePage showing full season matchup grid"
```

---

## Task 10: LineupPage

**Files:**
- Create: `client/src/pages/LineupPage.jsx`

**Interfaces:**
- Consumes: `api.leagues.lineup.get()`, `api.leagues.lineup.set()`, `api.leagues.schedule.get()`, `useOutletContext()` → `{league, myTeam}` (if `myTeam` not in context, fetch from `api.leagues.getTeams()`)

- [ ] **Step 1: Create the file**

```jsx
// client/src/pages/LineupPage.jsx
import { useState, useEffect, useCallback } from 'react'
import { useParams, useOutletContext, Link } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../auth/AuthContext.jsx'

const POS_LABEL = { F: 'Forwards', D: 'Defense', G: 'Goalies' }

export default function LineupPage() {
  const { leagueId }  = useParams()
  const { league }    = useOutletContext()
  const { user }      = useAuth()
  const [myTeam, setMyTeam]       = useState(null)
  const [periods, setPeriods]     = useState([])
  const [periodId, setPeriodId]   = useState(null)
  const [lineup, setLineup]       = useState(null)
  const [activeIds, setActiveIds] = useState(new Set())
  const [saving, setSaving]       = useState(false)
  const [msg, setMsg]             = useState(null)
  const [loading, setLoading]     = useState(true)

  useEffect(() => {
    Promise.all([
      api.leagues.getTeams(leagueId),
      api.leagues.schedule.get(leagueId),
    ]).then(([teams, sched]) => {
      const team = teams.find(t => t.user_id === user?.id) || teams[0]
      setMyTeam(team)
      setPeriods(sched.periods || [])
      const today = new Date().toISOString().slice(0, 10)
      const current = sched.periods.find(p => p.start_date <= today && p.end_date >= today)
      if (current) setPeriodId(current.id)
      else if (sched.periods.length) setPeriodId(sched.periods[0].id)
    }).catch(e => setMsg({ type: 'error', text: e.message }))
      .finally(() => setLoading(false))
  }, [leagueId])

  const fetchLineup = useCallback(() => {
    if (!myTeam || !periodId) return
    api.leagues.lineup.get(leagueId, myTeam.id, periodId)
      .then(data => {
        setLineup(data)
        setActiveIds(new Set(data.active.map(p => p.player_id)))
      })
      .catch(e => setMsg({ type: 'error', text: e.message }))
  }, [leagueId, myTeam, periodId])

  useEffect(() => { fetchLineup() }, [fetchLineup])

  function togglePlayer(playerId) {
    if (lineup?.locked) return
    setActiveIds(prev => {
      const next = new Set(prev)
      if (next.has(playerId)) next.delete(playerId)
      else next.add(playerId)
      return next
    })
  }

  async function saveLineup() {
    if (!myTeam || !periodId) return
    setSaving(true)
    setMsg(null)
    try {
      await api.leagues.lineup.set(leagueId, myTeam.id, periodId, [...activeIds])
      setMsg({ type: 'success', text: 'Lineup saved!' })
      fetchLineup()
    } catch (err) {
      setMsg({ type: 'error', text: err.message })
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="loading-state"><span className="loading-spinner" /> Loading lineup…</div>
  if (!periods.length) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
        <p>No schedule yet.</p>
        <Link to={`/leagues/${leagueId}/admin`}>Commissioners can generate one here.</Link>
      </div>
    )
  }

  const allPlayers = lineup ? [...(lineup.active || []), ...(lineup.bench || [])] : []
  const byPos = { F: [], D: [], G: [] }
  for (const p of allPlayers) byPos[p.position] = [...(byPos[p.position] || []), p]

  const slots = lineup?.slots || { F: 6, D: 3, G: 2 }
  const countByPos = { F: 0, D: 0, G: 0 }
  for (const pid of activeIds) {
    const p = allPlayers.find(pl => pl.player_id === pid)
    if (p) countByPos[p.position] = (countByPos[p.position] || 0) + 1
  }

  return (
    <div>
      <h1 className="page-title">Set Lineup</h1>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {periods.map(p => (
          <button
            key={p.id}
            onClick={() => setPeriodId(p.id)}
            className={`btn ${p.id === periodId ? 'btn-primary' : 'btn-ghost'}`}
            style={{ fontSize: '0.8rem', padding: '0.25rem 0.75rem' }}
          >
            Week {p.period_num}
          </button>
        ))}
      </div>

      {lineup?.locked && (
        <div className="alert" style={{ marginBottom: '1rem', background: 'var(--bg-card)', color: 'var(--text-muted)' }}>
          Lineup is locked for this week.
        </div>
      )}

      {['F', 'D', 'G'].map(pos => (
        <div key={pos} className="card" style={{ marginBottom: '1rem' }}>
          <h3 style={{ margin: '0 0 0.75rem' }}>
            {POS_LABEL[pos]}
            <span className="badge" style={{ marginLeft: '0.5rem', fontSize: '0.75rem' }}>
              {countByPos[pos] ?? 0} / {slots[pos]} active
            </span>
          </h3>
          {(byPos[pos] || []).map(p => {
            const isActive = activeIds.has(p.player_id)
            return (
              <div
                key={p.player_id}
                onClick={() => togglePlayer(p.player_id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.75rem',
                  padding: '0.5rem 0', borderTop: '1px solid var(--border)',
                  cursor: lineup?.locked ? 'default' : 'pointer',
                  opacity: lineup?.locked ? 0.7 : 1,
                }}
              >
                {p.headshot_url && <img src={p.headshot_url} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} />}
                <span style={{ flex: 1 }}>{p.player_name} <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>({p.nhl_team})</span></span>
                <span style={{
                  padding: '0.2rem 0.6rem', borderRadius: 4, fontSize: '0.75rem', fontWeight: 600,
                  background: isActive ? 'var(--accent)' : 'var(--bg-input)',
                  color: isActive ? '#fff' : 'var(--text-muted)',
                }}>
                  {isActive ? 'Active' : 'Bench'}
                </span>
              </div>
            )
          })}
        </div>
      ))}

      {msg && <div className={`alert alert-${msg.type === 'success' ? 'success' : 'error'}`}>{msg.text}</div>}

      {!lineup?.locked && (
        <button onClick={saveLineup} disabled={saving} className="btn btn-primary" style={{ width: '100%' }}>
          {saving ? 'Saving…' : 'Save Lineup'}
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Test in browser**

Go to `http://localhost:5173/leagues/1/lineup`. Expect players listed by position with Active/Bench toggles. Click a player to toggle, click Save Lineup, expect "Lineup saved!" message.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/LineupPage.jsx
git commit -m "feat: add LineupPage with active/bench toggle and period selector"
```

---

## Task 11: MatchupPage

**Files:**
- Create: `client/src/pages/MatchupPage.jsx`

**Interfaces:**
- Consumes: `api.leagues.matchup.current()`, `api.leagues.matchup.score()`

- [ ] **Step 1: Create the file**

```jsx
// client/src/pages/MatchupPage.jsx
import { useState, useEffect } from 'react'
import { useParams, useOutletContext } from 'react-router-dom'
import { api } from '../api.js'

export default function MatchupPage() {
  const { leagueId } = useParams()
  const { league }   = useOutletContext()
  const [data, setData]         = useState(null)
  const [loading, setLoading]   = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError]       = useState('')

  useEffect(() => {
    api.leagues.matchup.current(leagueId)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [leagueId])

  async function refresh() {
    setRefreshing(true)
    try {
      await api.leagues.matchup.score(leagueId)
      const d = await api.leagues.matchup.current(leagueId)
      setData(d)
    } catch (e) {
      setError(e.message)
    } finally {
      setRefreshing(false)
    }
  }

  if (loading) return <div className="loading-state"><span className="loading-spinner" /> Loading matchup…</div>
  if (error)   return <div className="alert alert-error">{error}</div>
  if (!data?.period) {
    return <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>No active matchup this week.</div>
  }
  if (!data?.matchup) {
    return <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>No matchup assigned for your team this week.</div>
  }

  const { period, matchup, myTeam, oppTeam, oppPlayers } = data
  const myIsHome = matchup.home_team_id === myTeam?.id
  const myScore  = myIsHome ? matchup.home_score : matchup.away_score
  const oppScore = myIsHome ? matchup.away_score : matchup.home_score
  const winning  = myScore > oppScore
  const tied     = myScore === oppScore

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '1rem' }}>
        <h1 className="page-title" style={{ margin: 0 }}>Week {period.period_num} Matchup</h1>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          {period.start_date} – {period.end_date}
        </span>
      </div>

      {/* Scoreboard */}
      <div className="card" style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'center', padding: '2rem', marginBottom: '1.5rem' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>You</div>
          <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{myTeam?.name}</div>
          <div style={{ fontSize: '2.5rem', fontWeight: 700, color: winning ? 'var(--accent)' : 'var(--text)' }}>
            {myScore.toFixed(1)}
          </div>
        </div>
        <div style={{ fontSize: '1.25rem', color: 'var(--text-muted)', fontWeight: 600 }}>vs</div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Opponent</div>
          <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{oppTeam?.name}</div>
          <div style={{ fontSize: '2.5rem', fontWeight: 700, color: !winning && !tied ? 'var(--accent)' : 'var(--text)' }}>
            {oppScore.toFixed(1)}
          </div>
        </div>
      </div>

      {/* Status */}
      <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        {tied
          ? <span className="badge">Tied</span>
          : winning
            ? <span className="badge" style={{ background: 'var(--accent)' }}>You're winning</span>
            : <span className="badge" style={{ background: 'var(--text-muted)' }}>Opponent is winning</span>
        }
        <button onClick={refresh} disabled={refreshing} className="btn btn-ghost" style={{ marginLeft: '0.75rem', fontSize: '0.85rem' }}>
          {refreshing ? 'Updating…' : 'Refresh Scores'}
        </button>
      </div>

      {/* Opponent roster */}
      <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Opponent Roster</h2>
      <div className="card">
        {(oppPlayers || []).map(p => (
          <div key={p.player_id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.4rem 0', borderTop: '1px solid var(--border)' }}>
            {p.headshot_url && <img src={p.headshot_url} alt="" style={{ width: 32, height: 32, borderRadius: '50%' }} />}
            <span style={{ flex: 1 }}>{p.player_name}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{p.nhl_team} · {p.position}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Test in browser**

Go to `http://localhost:5173/leagues/1/matchup`. Expect a scoreboard card with both team names and scores, a winning/losing/tied badge, a Refresh Scores button, and the opponent's roster.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/MatchupPage.jsx
git commit -m "feat: add MatchupPage with live scoreboard and opponent roster"
```

---

## Task 12: Standings W/L/T Columns

**Files:**
- Modify: `client/src/pages/Standings.jsx`

**Interfaces:**
- Consumes: existing `api.leagues.getStandings()` — now returns `wins`, `losses`, `ties` per team

- [ ] **Step 1: Add W/L/T to the desktop standings header row**

In `client/src/pages/Standings.jsx` find the header row `<div className="st-row st-head">` (line ~107). It currently contains `#`, `Team`, `Active`, `Dead`, `Skater`, `Goalie`, `Total`. Add three new columns between `Team` and `Active`:

```jsx
          <div className="st-row st-head">
            <div className="st-rank">#</div>
            <div className="st-team">Team</div>
            <div className="st-num">W</div>
            <div className="st-num">L</div>
            <div className="st-num">T</div>
            <div className="st-num">Active</div>
            <div className="st-num">Dead</div>
            <div className="st-num">Skater</div>
            <div className="st-num">Goalie</div>
            <div className="st-num st-total">Total</div>
          </div>
```

- [ ] **Step 2: Add W/L/T values to each data row**

Find the data row `<div key={t.id} className={...} onClick={...}>` (line ~117). Add matching value divs between `st-team` and the first `st-num` (Active):

```jsx
              <div className="st-num" style={{ fontWeight: 600, color: 'var(--accent)' }}>{t.wins ?? 0}</div>
              <div className="st-num st-dim">{t.losses ?? 0}</div>
              <div className="st-num st-dim">{t.ties ?? 0}</div>
```

- [ ] **Step 3: Add W/L/T to the mobile SwipeStandings card**

In `client/src/components/SwipeStandings.jsx`, find the `swipe-meta` div (line ~23). Add a W/L/T entry:

```jsx
            <div className="swipe-meta">
              <div><span>{t.wins ?? 0}-{t.losses ?? 0}</span><label>W-L</label></div>
              <div><span>{t.active}/{t.total}</span><label>active</label></div>
              <div><span className={t.dead > 0 ? 'st-danger' : ''}>{t.dead}</span><label>dead</label></div>
              <div><span>{t.skaterPts}</span><label>skater</label></div>
              <div><span>{t.goaliePts}</span><label>goalie</label></div>
            </div>
```

- [ ] **Step 3: Test in browser**

Go to `http://localhost:5173/leagues/1/standings`. Expect W, L, T columns in the table. After generating a schedule and scoring a matchup via the commissioner dashboard, the values should update.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/Standings.jsx client/src/components/SwipeStandings.jsx
git commit -m "feat: add W/L/T columns to standings table and mobile swipe cards"
```

---

## Phase 1 Complete — Verification Checklist

- [ ] Migration applied: `matchup_periods`, `matchups`, `active_roster` tables exist
- [ ] Commissioner can generate a round-robin schedule from the admin dashboard
- [ ] Schedule page shows all weeks and matchup pairings
- [ ] Manager can set active/bench lineup for the current week
- [ ] Lineup is blocked after lock time
- [ ] Matchup score endpoint returns correct scores (only active player points summed)
- [ ] Matchup page shows live scoreboard and opponent roster
- [ ] Standings shows W/L/T record, sorted by record then points
- [ ] Cron tick scores all leagues' current-period matchups automatically

---

## Phase 2 Plan

Phase 2 (Waiver Wire + Trades) will be a separate plan file:
`docs/superpowers/plans/2026-06-19-phase2-waiver-trades.md`

It builds on the `waiver_priority` column added in migration 0011. Start Phase 2 only after Phase 1 is fully working.
