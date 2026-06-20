# Phase 2 — Waiver Wire + Trades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add waiver wire (24h claim window, priority-based processing) and multi-player trades (commissioner veto window) to the Playoff-Fantasy multi-tenant NHL fantasy hockey app.

**Architecture:** All new API routes live in `worker/index.js` following the existing `if (pathnameMatch && method)` pattern with `loadLeagueContext(db, request, leagueId)` for auth. Two new helpers (`processWaivers`, `executeTrades`) integrate into the existing hourly cron loop. Four new React pages/components are added as nested routes under `/leagues/:leagueId`.

**Tech Stack:** Cloudflare Workers + D1 (SQLite), React 18 + React Router v6 + Vite. No new dependencies.

## Global Constraints

- No new npm dependencies. Zero.
- Migration 0012 is additive only — no DROP TABLE, no column renames, no altering existing columns.
- All new worker routes follow: `const xyzMatch = pathname.match(/^\/api\/...$/)` → `if (xyzMatch && request.method === 'METHOD')` → `const ctx = await loadLeagueContext(db, request, leagueId)` → `if (ctx.error) return ctx.error`.
- `loadLeagueContext(db, request, leagueId)` returns `{ user, league, role, error }` — `db` comes from `env.DB` at the top of `handleApi`, NOT from the context object.
- `isCommissioner(ctx.league, ctx.role, ctx.user.id)` → returns boolean.
- `parseId(value)` converts route param strings to integers.
- `team_players` columns: `id, team_id, player_id, player_name, nhl_team, position, position_detail, headshot_url, crest_url`.
- `dropped_players` status values: `'waivers'` | `'free_agent'` | `'claimed'`.
- `trade_proposals` status values: `'pending'` | `'accepted'` | `'rejected'` | `'countered'` | `'vetoed'` | `'executed'` | `'expired'`.
- Frontend pages use `useParams()`, `useOutletContext()`, `useAuth()` (from `../auth/AuthContext.jsx`).
- New routes nested under `/leagues/:leagueId` in `client/src/App.jsx`'s `<LeagueLayout>` section.
- No trailing-summary comments, no doc comments, no "added for X" notes. Only add a comment when the WHY is non-obvious.

---

## File Map

| Status | File | What Changes |
|--------|------|-------------|
| Create | `migrations/0012_transactions.sql` | 4 new tables |
| Modify | `worker/index.js` | Config default, 10 new endpoints, 2 cron helpers |
| Modify | `client/src/api.js` | `leagues.waivers.*` and `leagues.trades.*` method groups |
| Modify | `client/src/App.jsx` | Import + 2 new routes |
| Modify | `client/src/components/LeagueLayout.jsx` | 2 new nav links |
| Create | `client/src/pages/WaiverWirePage.jsx` | Waivers browse + claim + pickup |
| Create | `client/src/pages/TradesPage.jsx` | Trade inbox/outbox + history |
| Create | `client/src/components/TradeProposalModal.jsx` | 3-step propose flow |
| Modify | `client/src/pages/CommissionerDashboard.jsx` | Veto panel + reset priorities button |

---

### Task 1: Migration 0012 + Config Default

**Files:**
- Create: `migrations/0012_transactions.sql`
- Modify: `worker/index.js` (lines 225–264 — DEFAULT_LEAGUE_CONFIG and mergeConfig)

**Interfaces:**
- Produces: `dropped_players`, `waiver_claims`, `trade_proposals`, `trade_items` tables; `config.trade_veto_hours` (number, default 24) available via `mergeConfig()`

- [ ] **Step 1: Create the migration file**

```sql
-- migrations/0012_transactions.sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS dropped_players (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id           INTEGER NOT NULL,
  player_id           INTEGER NOT NULL,
  player_name         TEXT NOT NULL,
  player_meta_json    TEXT NOT NULL DEFAULT '{}',
  dropped_by_team_id  INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'waivers',
  waiver_deadline     DATETIME,
  dropped_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (league_id)          REFERENCES leagues(id) ON DELETE CASCADE,
  FOREIGN KEY (dropped_by_team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS waiver_claims (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id         INTEGER NOT NULL,
  team_id           INTEGER NOT NULL,
  dropped_player_id INTEGER NOT NULL,
  drop_player_id    INTEGER,
  priority_at_time  INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  processed_at      DATETIME,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (league_id)         REFERENCES leagues(id)         ON DELETE CASCADE,
  FOREIGN KEY (team_id)           REFERENCES teams(id)           ON DELETE CASCADE,
  FOREIGN KEY (dropped_player_id) REFERENCES dropped_players(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS trade_proposals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id         INTEGER NOT NULL,
  proposing_team_id INTEGER NOT NULL,
  receiving_team_id INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  veto_deadline     DATETIME,
  expires_at        DATETIME NOT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (league_id)         REFERENCES leagues(id) ON DELETE CASCADE,
  FOREIGN KEY (proposing_team_id) REFERENCES teams(id),
  FOREIGN KEY (receiving_team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS trade_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id     INTEGER NOT NULL,
  from_team_id INTEGER NOT NULL,
  player_id    INTEGER NOT NULL,
  player_name  TEXT NOT NULL,
  FOREIGN KEY (trade_id)     REFERENCES trade_proposals(id) ON DELETE CASCADE,
  FOREIGN KEY (from_team_id) REFERENCES teams(id)
);
```

- [ ] **Step 2: Add `trade_veto_hours` to DEFAULT_LEAGUE_CONFIG**

In `worker/index.js` at line 241 (after `commissionerNotes: ''`), add:

```js
const DEFAULT_LEAGUE_CONFIG = {
  scoring: {
    skater: { goal: 2, assist: 1, specialTeamsPointBonus: 1, pim: 0.5 },
    goalie: { win: 2, shutout: 3, gaaRank: true, svpRank: true },
  },
  roster: { maxF: 10, maxD: 5, maxG: 3, maxSameTeamF: 3, maxSameTeamD: 2 },
  active_slots: { F: 6, D: 3, G: 2 },
  lineup_lock_hour_utc: 23,
  trade_veto_hours: 24,
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

- [ ] **Step 3: Update `mergeConfig` to propagate `trade_veto_hours`**

In `mergeConfig` (lines 244–264), the return object currently ends with `tiebreaker`. Add `trade_veto_hours` to the return:

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
    trade_veto_hours: parsed.trade_veto_hours ?? d.trade_veto_hours,
    lock: { ...d.lock, ...(parsed.lock) },
    payout: Array.isArray(parsed.payout) ? parsed.payout : d.payout,
    tiebreaker: { ...d.tiebreaker, ...(parsed.tiebreaker) },
  };
}
```

- [ ] **Step 4: Verify syntax**

```bash
node --check worker/index.js
```

Expected: no output (clean).

- [ ] **Step 5: Commit**

```bash
git add migrations/0012_transactions.sql worker/index.js
git commit -m "feat: add waiver/trade migration (0012) and trade_veto_hours config default"
```

---

### Task 2: Worker — Drop Player + Waiver List

**Files:**
- Modify: `worker/index.js` — add 2 routes before the `// League-scoped teams` comment (~line 1133)

**Interfaces:**
- Consumes: `loadLeagueContext(db, request, leagueId)`, `parseId()`, `json()`
- Produces:
  - `POST /api/leagues/:id/players/:playerId/drop` → `{ ok: true, waiver_deadline: string }`
  - `GET /api/leagues/:id/waivers` → `{ players: DroppedPlayer[], myClaims: WaiverClaim[] }`

- [ ] **Step 1: Add the drop and waivers routes**

Insert the following block in `worker/index.js` immediately before the `// League-scoped teams` comment (~line 1133). These are two separate `if` blocks:

```js
  // ── Waivers ───────────────────────────────────────────────────────────────
  const dropPlayerMatch = pathname.match(/^\/api\/leagues\/(\d+)\/players\/(\d+)\/drop$/);
  if (dropPlayerMatch && request.method === 'POST') {
    const leagueId = parseId(dropPlayerMatch[1]);
    const playerId = parseId(dropPlayerMatch[2]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;

    const team = await db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id = ?')
      .bind(leagueId, ctx.user.id).first();
    if (!team) return json({ error: 'You have no team in this league' }, { status: 404 });

    const player = await db.prepare('SELECT * FROM team_players WHERE team_id = ? AND player_id = ?')
      .bind(team.id, playerId).first();
    if (!player) return json({ error: 'Player not on your team' }, { status: 404 });

    const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const meta = JSON.stringify({
      position: player.position,
      nhl_team: player.nhl_team,
      headshot_url: player.headshot_url,
      crest_url: player.crest_url,
    });

    await db.batch([
      db.prepare('DELETE FROM team_players WHERE id = ?').bind(player.id),
      db.prepare(`INSERT INTO dropped_players
        (league_id, player_id, player_name, player_meta_json, dropped_by_team_id, status, waiver_deadline)
        VALUES (?, ?, ?, ?, ?, 'waivers', ?)`)
        .bind(leagueId, playerId, player.player_name, meta, team.id, deadline),
    ]);

    return json({ ok: true, waiver_deadline: deadline });
  }

  const waiversListMatch = pathname.match(/^\/api\/leagues\/(\d+)\/waivers$/);
  if (waiversListMatch && request.method === 'GET') {
    const leagueId = parseId(waiversListMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;

    const { results: players } = await db.prepare(`
      SELECT dp.*, t.name AS dropped_by_team_name
      FROM dropped_players dp
      JOIN teams t ON t.id = dp.dropped_by_team_id
      WHERE dp.league_id = ? AND dp.status IN ('waivers', 'free_agent')
      ORDER BY dp.dropped_at DESC
    `).bind(leagueId).all();

    const myTeam = await db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id = ?')
      .bind(leagueId, ctx.user.id).first();

    const myClaims = myTeam
      ? (await db.prepare(`SELECT * FROM waiver_claims WHERE team_id = ? AND status = 'pending'`)
          .bind(myTeam.id).all()).results || []
      : [];

    return json({ players: players || [], myClaims });
  }
```

- [ ] **Step 2: Verify syntax**

```bash
node --check worker/index.js
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add worker/index.js
git commit -m "feat: add drop-player and waiver-list endpoints"
```

---

### Task 3: Worker — Waiver Claim, Cancel, Free Agent Pickup, Reset Priorities

**Files:**
- Modify: `worker/index.js` — 4 more routes in the Waivers section

**Interfaces:**
- Consumes: tables from Task 1 migration
- Produces:
  - `POST /api/leagues/:id/waivers/claim` → `{ ok: true, claim_id: number }`
  - `DELETE /api/leagues/:id/waivers/claim/:claimId` → `{ ok: true }`
  - `POST /api/leagues/:id/free-agents/:droppedPlayerId/pickup` → `{ ok: true }`
  - `POST /api/leagues/:id/waivers/reset-priorities` → `{ ok: true }` (commissioner only)

- [ ] **Step 1: Add the four routes**

Insert the following block immediately after the `waiversListMatch` block from Task 2:

```js
  const waiverClaimMatch = pathname.match(/^\/api\/leagues\/(\d+)\/waivers\/claim$/);
  if (waiverClaimMatch && request.method === 'POST') {
    const leagueId = parseId(waiverClaimMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;

    const { dropped_player_id, drop_player_id } = await request.json();
    if (!dropped_player_id) return json({ error: 'dropped_player_id required' }, { status: 400 });

    const team = await db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id = ?')
      .bind(leagueId, ctx.user.id).first();
    if (!team) return json({ error: 'You have no team in this league' }, { status: 404 });

    const dp = await db.prepare('SELECT id, status, waiver_deadline FROM dropped_players WHERE id = ? AND league_id = ?')
      .bind(dropped_player_id, leagueId).first();
    if (!dp) return json({ error: 'Player not found' }, { status: 404 });
    if (dp.status !== 'waivers') return json({ error: 'Player is not on waivers' }, { status: 400 });
    if (dp.waiver_deadline && new Date(dp.waiver_deadline) <= new Date()) {
      return json({ error: 'Waiver window has closed' }, { status: 400 });
    }

    const existing = await db.prepare(
      `SELECT id FROM waiver_claims WHERE team_id = ? AND dropped_player_id = ? AND status = 'pending'`
    ).bind(team.id, dropped_player_id).first();
    if (existing) return json({ error: 'Already have a pending claim on this player' }, { status: 400 });

    const member = await db.prepare('SELECT waiver_priority FROM league_members WHERE league_id = ? AND user_id = ?')
      .bind(leagueId, ctx.user.id).first();
    const priority = member?.waiver_priority ?? 0;

    const row = await db.prepare(`
      INSERT INTO waiver_claims (league_id, team_id, dropped_player_id, drop_player_id, priority_at_time, status)
      VALUES (?, ?, ?, ?, ?, 'pending') RETURNING id
    `).bind(leagueId, team.id, dropped_player_id, drop_player_id ?? null, priority).first();

    return json({ ok: true, claim_id: row.id });
  }

  const waiverClaimCancelMatch = pathname.match(/^\/api\/leagues\/(\d+)\/waivers\/claim\/(\d+)$/);
  if (waiverClaimCancelMatch && request.method === 'DELETE') {
    const leagueId = parseId(waiverClaimCancelMatch[1]);
    const claimId = parseId(waiverClaimCancelMatch[2]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;

    const team = await db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id = ?')
      .bind(leagueId, ctx.user.id).first();
    if (!team) return json({ error: 'You have no team in this league' }, { status: 404 });

    const claim = await db.prepare('SELECT id, status, team_id FROM waiver_claims WHERE id = ? AND league_id = ?')
      .bind(claimId, leagueId).first();
    if (!claim) return json({ error: 'Claim not found' }, { status: 404 });
    if (claim.team_id !== team.id) return json({ error: 'Not your claim' }, { status: 403 });
    if (claim.status !== 'pending') return json({ error: 'Claim already processed' }, { status: 400 });

    await db.prepare(`UPDATE waiver_claims SET status = 'expired' WHERE id = ?`).bind(claimId).run();
    return json({ ok: true });
  }

  const freeAgentPickupMatch = pathname.match(/^\/api\/leagues\/(\d+)\/free-agents\/(\d+)\/pickup$/);
  if (freeAgentPickupMatch && request.method === 'POST') {
    const leagueId = parseId(freeAgentPickupMatch[1]);
    const droppedPlayerId = parseId(freeAgentPickupMatch[2]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;

    const team = await db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id = ?')
      .bind(leagueId, ctx.user.id).first();
    if (!team) return json({ error: 'You have no team in this league' }, { status: 404 });

    const dp = await db.prepare('SELECT * FROM dropped_players WHERE id = ? AND league_id = ?')
      .bind(droppedPlayerId, leagueId).first();
    if (!dp) return json({ error: 'Player not found' }, { status: 404 });
    if (dp.status !== 'free_agent') return json({ error: 'Player is not a free agent' }, { status: 400 });

    const meta = JSON.parse(dp.player_meta_json || '{}');

    await db.batch([
      db.prepare(`UPDATE dropped_players SET status = 'claimed' WHERE id = ?`).bind(droppedPlayerId),
      db.prepare(`INSERT INTO team_players
        (team_id, player_id, player_name, nhl_team, position, position_detail, headshot_url, crest_url)
        VALUES (?, ?, ?, ?, ?, '', ?, ?)`)
        .bind(team.id, dp.player_id, dp.player_name, meta.nhl_team || '', meta.position || '',
              meta.headshot_url || '', meta.crest_url || ''),
    ]);

    return json({ ok: true });
  }

  const waiverResetMatch = pathname.match(/^\/api\/leagues\/(\d+)\/waivers\/reset-priorities$/);
  if (waiverResetMatch && request.method === 'POST') {
    const leagueId = parseId(waiverResetMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id)) {
      return json({ error: 'Commissioner only' }, { status: 403 });
    }
    await db.prepare('UPDATE league_members SET waiver_priority = 0 WHERE league_id = ?').bind(leagueId).run();
    return json({ ok: true });
  }
```

- [ ] **Step 2: Verify syntax**

```bash
node --check worker/index.js
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add worker/index.js
git commit -m "feat: add waiver claim, cancel, free-agent pickup, and reset-priorities endpoints"
```

---

### Task 4: Worker — Trade Endpoints

**Files:**
- Modify: `worker/index.js` — 3 route blocks (GET trades, POST trades, PUT trade action) in a new Trades section

**Interfaces:**
- Produces:
  - `GET /api/leagues/:id/trades` → `{ trades: TradeWithItems[] }` where each trade has `proposing_team_name`, `receiving_team_name`, `items: TradeItem[]`
  - `POST /api/leagues/:id/trades` body `{ receiving_team_id, offering: number[], requesting: number[] }` → `{ ok: true, trade_id: number }`
  - `PUT /api/leagues/:id/trades/:tradeId/accept` → `{ ok: true, veto_deadline: string }`
  - `PUT /api/leagues/:id/trades/:tradeId/reject` → `{ ok: true }`
  - `PUT /api/leagues/:id/trades/:tradeId/counter` body `{ offering: number[], requesting: number[] }` → `{ ok: true, counter_trade_id: number }`
  - `PUT /api/leagues/:id/trades/:tradeId/veto` (commissioner) → `{ ok: true }`

- [ ] **Step 1: Add trade routes**

Insert immediately after the Waivers block (after the `waiverResetMatch` block from Task 3), before the `// League-scoped teams` comment:

```js
  // ── Trades ────────────────────────────────────────────────────────────────
  const tradesListMatch = pathname.match(/^\/api\/leagues\/(\d+)\/trades$/);
  if (tradesListMatch && request.method === 'GET') {
    const leagueId = parseId(tradesListMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;

    const { results: trades } = await db.prepare(`
      SELECT tp.*, t1.name AS proposing_team_name, t2.name AS receiving_team_name
      FROM trade_proposals tp
      JOIN teams t1 ON t1.id = tp.proposing_team_id
      JOIN teams t2 ON t2.id = tp.receiving_team_id
      WHERE tp.league_id = ?
      ORDER BY tp.created_at DESC
    `).bind(leagueId).all();

    const result = await Promise.all((trades || []).map(async (t) => {
      const { results: items } = await db.prepare('SELECT * FROM trade_items WHERE trade_id = ?').bind(t.id).all();
      return { ...t, items: items || [] };
    }));

    return json({ trades: result });
  }

  if (tradesListMatch && request.method === 'POST') {
    const leagueId = parseId(tradesListMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;

    const { receiving_team_id, offering, requesting } = await request.json();
    if (!receiving_team_id || !Array.isArray(offering) || !Array.isArray(requesting)
        || offering.length === 0 || requesting.length === 0) {
      return json({ error: 'receiving_team_id, offering (non-empty), and requesting (non-empty) required' }, { status: 400 });
    }

    const myTeam = await db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id = ?')
      .bind(leagueId, ctx.user.id).first();
    if (!myTeam) return json({ error: 'You have no team in this league' }, { status: 404 });
    if (myTeam.id === receiving_team_id) return json({ error: 'Cannot trade with yourself' }, { status: 400 });

    const receivingTeam = await db.prepare('SELECT id FROM teams WHERE id = ? AND league_id = ?')
      .bind(receiving_team_id, leagueId).first();
    if (!receivingTeam) return json({ error: 'Receiving team not found' }, { status: 404 });

    for (const pid of offering) {
      const p = await db.prepare('SELECT player_id, player_name FROM team_players WHERE team_id = ? AND player_id = ?')
        .bind(myTeam.id, pid).first();
      if (!p) return json({ error: `Player ${pid} not on your team` }, { status: 400 });
    }
    for (const pid of requesting) {
      const p = await db.prepare('SELECT player_id, player_name FROM team_players WHERE team_id = ? AND player_id = ?')
        .bind(receiving_team_id, pid).first();
      if (!p) return json({ error: `Player ${pid} not on receiving team` }, { status: 400 });
    }

    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const trade = await db.prepare(`
      INSERT INTO trade_proposals (league_id, proposing_team_id, receiving_team_id, status, expires_at)
      VALUES (?, ?, ?, 'pending', ?) RETURNING id
    `).bind(leagueId, myTeam.id, receiving_team_id, expiresAt).first();

    const offeringRows = await Promise.all(offering.map(pid =>
      db.prepare('SELECT player_id, player_name FROM team_players WHERE team_id = ? AND player_id = ?')
        .bind(myTeam.id, pid).first()
    ));
    const requestingRows = await Promise.all(requesting.map(pid =>
      db.prepare('SELECT player_id, player_name FROM team_players WHERE team_id = ? AND player_id = ?')
        .bind(receiving_team_id, pid).first()
    ));

    await db.batch([
      ...offeringRows.map(p => db.prepare('INSERT INTO trade_items (trade_id, from_team_id, player_id, player_name) VALUES (?, ?, ?, ?)')
        .bind(trade.id, myTeam.id, p.player_id, p.player_name)),
      ...requestingRows.map(p => db.prepare('INSERT INTO trade_items (trade_id, from_team_id, player_id, player_name) VALUES (?, ?, ?, ?)')
        .bind(trade.id, receiving_team_id, p.player_id, p.player_name)),
    ]);

    return json({ ok: true, trade_id: trade.id });
  }

  const tradeActionMatch = pathname.match(/^\/api\/leagues\/(\d+)\/trades\/(\d+)\/(accept|reject|counter|veto)$/);
  if (tradeActionMatch && request.method === 'PUT') {
    const leagueId = parseId(tradeActionMatch[1]);
    const tradeId = parseId(tradeActionMatch[2]);
    const action = tradeActionMatch[3];
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;

    const trade = await db.prepare('SELECT * FROM trade_proposals WHERE id = ? AND league_id = ?')
      .bind(tradeId, leagueId).first();
    if (!trade) return json({ error: 'Trade not found' }, { status: 404 });

    const myTeam = await db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id = ?')
      .bind(leagueId, ctx.user.id).first();

    if (action === 'accept' || action === 'reject' || action === 'counter') {
      if (!myTeam || myTeam.id !== trade.receiving_team_id) {
        return json({ error: 'Only the receiving team can respond to this trade' }, { status: 403 });
      }
      if (trade.status !== 'pending') {
        return json({ error: 'Trade is no longer pending' }, { status: 400 });
      }

      if (action === 'accept') {
        const config = mergeConfig(ctx.league.config_json);
        const vetoDeadline = new Date(Date.now() + (config.trade_veto_hours ?? 24) * 60 * 60 * 1000).toISOString();
        await db.prepare(`UPDATE trade_proposals SET status = 'accepted', veto_deadline = ? WHERE id = ?`)
          .bind(vetoDeadline, tradeId).run();
        return json({ ok: true, veto_deadline: vetoDeadline });
      }

      if (action === 'reject') {
        await db.prepare(`UPDATE trade_proposals SET status = 'rejected' WHERE id = ?`).bind(tradeId).run();
        return json({ ok: true });
      }

      if (action === 'counter') {
        const { offering, requesting } = await request.json();
        if (!Array.isArray(offering) || !Array.isArray(requesting) || offering.length === 0 || requesting.length === 0) {
          return json({ error: 'offering and requesting arrays required' }, { status: 400 });
        }
        for (const pid of offering) {
          const p = await db.prepare('SELECT player_id FROM team_players WHERE team_id = ? AND player_id = ?')
            .bind(myTeam.id, pid).first();
          if (!p) return json({ error: `Player ${pid} not on your team` }, { status: 400 });
        }
        for (const pid of requesting) {
          const p = await db.prepare('SELECT player_id FROM team_players WHERE team_id = ? AND player_id = ?')
            .bind(trade.proposing_team_id, pid).first();
          if (!p) return json({ error: `Player ${pid} not on opposing team` }, { status: 400 });
        }

        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
        await db.prepare(`UPDATE trade_proposals SET status = 'countered' WHERE id = ?`).bind(tradeId).run();

        const counter = await db.prepare(`
          INSERT INTO trade_proposals (league_id, proposing_team_id, receiving_team_id, status, expires_at)
          VALUES (?, ?, ?, 'pending', ?) RETURNING id
        `).bind(leagueId, myTeam.id, trade.proposing_team_id, expiresAt).first();

        const offeringRows = await Promise.all(offering.map(pid =>
          db.prepare('SELECT player_id, player_name FROM team_players WHERE team_id = ? AND player_id = ?')
            .bind(myTeam.id, pid).first()
        ));
        const requestingRows = await Promise.all(requesting.map(pid =>
          db.prepare('SELECT player_id, player_name FROM team_players WHERE team_id = ? AND player_id = ?')
            .bind(trade.proposing_team_id, pid).first()
        ));

        await db.batch([
          ...offeringRows.map(p => db.prepare('INSERT INTO trade_items (trade_id, from_team_id, player_id, player_name) VALUES (?, ?, ?, ?)')
            .bind(counter.id, myTeam.id, p.player_id, p.player_name)),
          ...requestingRows.map(p => db.prepare('INSERT INTO trade_items (trade_id, from_team_id, player_id, player_name) VALUES (?, ?, ?, ?)')
            .bind(counter.id, trade.proposing_team_id, p.player_id, p.player_name)),
        ]);

        return json({ ok: true, counter_trade_id: counter.id });
      }
    }

    if (action === 'veto') {
      if (!isCommissioner(ctx.league, ctx.role, ctx.user.id)) {
        return json({ error: 'Commissioner only' }, { status: 403 });
      }
      if (trade.status !== 'accepted') {
        return json({ error: 'Can only veto accepted trades' }, { status: 400 });
      }
      await db.prepare(`UPDATE trade_proposals SET status = 'vetoed' WHERE id = ?`).bind(tradeId).run();
      return json({ ok: true });
    }
  }
```

- [ ] **Step 2: Verify syntax**

```bash
node --check worker/index.js
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add worker/index.js
git commit -m "feat: add trade list, propose, accept/reject/counter/veto endpoints"
```

---

### Task 5: Worker — Cron: Waiver Processing + Trade Execution

**Files:**
- Modify: `worker/index.js` — add 2 helper functions before `export default`, update `scheduled` loop

**Interfaces:**
- Consumes: `dropped_players`, `waiver_claims`, `trade_proposals`, `trade_items`, `league_members`, `team_players`
- Produces: `processWaivers(db, leagueId)` async helper, `executeTrades(db, leagueId)` async helper; both called in per-league cron loop

- [ ] **Step 1: Add `processWaivers` helper**

Insert the following function in `worker/index.js` immediately before the `export default {` line (currently ~line 2017):

```js
async function processWaivers(db, leagueId) {
  const now = new Date().toISOString();

  const { results: expiredPlayers } = await db.prepare(`
    SELECT * FROM dropped_players
    WHERE league_id = ? AND status = 'waivers' AND waiver_deadline <= ?
  `).bind(leagueId, now).all();

  for (const dp of (expiredPlayers || [])) {
    const { results: claims } = await db.prepare(`
      SELECT wc.* FROM waiver_claims wc
      WHERE wc.dropped_player_id = ? AND wc.status = 'pending'
      ORDER BY wc.priority_at_time ASC, wc.created_at ASC
    `).bind(dp.id).all();

    if (!claims || claims.length === 0) {
      await db.prepare(`UPDATE dropped_players SET status = 'free_agent' WHERE id = ?`).bind(dp.id).run();
      continue;
    }

    let winnerClaim = null;
    for (const claim of claims) {
      if (claim.drop_player_id) {
        const dropTarget = await db.prepare(
          'SELECT id FROM team_players WHERE team_id = ? AND player_id = ?'
        ).bind(claim.team_id, claim.drop_player_id).first();
        if (!dropTarget) continue;
      }
      winnerClaim = claim;
      break;
    }

    if (!winnerClaim) {
      await db.batch([
        db.prepare(`UPDATE dropped_players SET status = 'free_agent' WHERE id = ?`).bind(dp.id),
        db.prepare(`UPDATE waiver_claims SET status = 'denied', processed_at = ?
          WHERE dropped_player_id = ? AND status = 'pending'`).bind(now, dp.id),
      ]);
      continue;
    }

    const meta = JSON.parse(dp.player_meta_json || '{}');
    const batchOps = [
      db.prepare(`UPDATE dropped_players SET status = 'claimed' WHERE id = ?`).bind(dp.id),
      db.prepare(`UPDATE waiver_claims SET status = 'approved', processed_at = ? WHERE id = ?`).bind(now, winnerClaim.id),
      db.prepare(`UPDATE waiver_claims SET status = 'denied', processed_at = ?
        WHERE dropped_player_id = ? AND status = 'pending' AND id != ?`).bind(now, dp.id, winnerClaim.id),
      db.prepare(`INSERT INTO team_players
        (team_id, player_id, player_name, nhl_team, position, position_detail, headshot_url, crest_url)
        VALUES (?, ?, ?, ?, ?, '', ?, ?)`)
        .bind(winnerClaim.team_id, dp.player_id, dp.player_name,
              meta.nhl_team || '', meta.position || '', meta.headshot_url || '', meta.crest_url || ''),
    ];

    if (winnerClaim.drop_player_id) {
      batchOps.push(
        db.prepare('DELETE FROM team_players WHERE team_id = ? AND player_id = ?')
          .bind(winnerClaim.team_id, winnerClaim.drop_player_id)
      );
    }

    await db.batch(batchOps);

    // Move winning team to last waiver priority
    const winTeam = await db.prepare('SELECT user_id FROM teams WHERE id = ?').bind(winnerClaim.team_id).first();
    if (winTeam) {
      const { results: members } = await db.prepare(
        'SELECT waiver_priority FROM league_members WHERE league_id = ?'
      ).bind(leagueId).all();
      const maxPriority = Math.max(...(members || []).map(m => m.waiver_priority), 0);
      await db.prepare('UPDATE league_members SET waiver_priority = ? WHERE league_id = ? AND user_id = ?')
        .bind(maxPriority + 1, leagueId, winTeam.user_id).run();
    }
  }
}

async function executeTrades(db, leagueId) {
  const now = new Date().toISOString();

  const { results: readyTrades } = await db.prepare(`
    SELECT * FROM trade_proposals
    WHERE league_id = ? AND status = 'accepted' AND veto_deadline <= ?
  `).bind(leagueId, now).all();

  for (const trade of (readyTrades || [])) {
    const { results: items } = await db.prepare('SELECT * FROM trade_items WHERE trade_id = ?')
      .bind(trade.id).all();

    const batchOps = (items || []).map(item => {
      const toTeamId = item.from_team_id === trade.proposing_team_id
        ? trade.receiving_team_id
        : trade.proposing_team_id;
      return db.prepare('UPDATE team_players SET team_id = ? WHERE team_id = ? AND player_id = ?')
        .bind(toTeamId, item.from_team_id, item.player_id);
    });
    batchOps.push(
      db.prepare(`UPDATE trade_proposals SET status = 'executed' WHERE id = ?`).bind(trade.id)
    );

    await db.batch(batchOps);
  }

  // Expire stale pending trades
  await db.prepare(`
    UPDATE trade_proposals SET status = 'expired'
    WHERE league_id = ? AND status = 'pending' AND expires_at <= ?
  `).bind(leagueId, now).run();
}
```

- [ ] **Step 2: Update the per-league cron loop**

In the `scheduled` handler (~line 2028), after the existing `scoreMatchupsForLeague` try/catch block (which ends around line 2043), add:

```js
        try {
          await processWaivers(db, league.id);
        } catch (err) {
          console.error(`[cron] league ${league.id} waiver processing failed:`, err?.message ?? err);
        }
        try {
          await executeTrades(db, league.id);
        } catch (err) {
          console.error(`[cron] league ${league.id} trade execution failed:`, err?.message ?? err);
        }
```

The full per-league try/catch block should now look like this after the edit:

```js
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
        try {
          await processWaivers(db, league.id);
        } catch (err) {
          console.error(`[cron] league ${league.id} waiver processing failed:`, err?.message ?? err);
        }
        try {
          await executeTrades(db, league.id);
        } catch (err) {
          console.error(`[cron] league ${league.id} trade execution failed:`, err?.message ?? err);
        }
      }
```

- [ ] **Step 3: Verify syntax**

```bash
node --check worker/index.js
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add worker/index.js
git commit -m "feat: add processWaivers and executeTrades cron helpers"
```

---

### Task 6: API Client + Routes + Nav

**Files:**
- Modify: `client/src/api.js` — add `leagues.waivers` and `leagues.trades` method groups
- Modify: `client/src/App.jsx` — import 2 new pages, add 2 routes
- Modify: `client/src/components/LeagueLayout.jsx` — add Waivers and Trades nav links

**Interfaces:**
- Produces (consumed by Tasks 7–9):
  - `api.leagues.waivers.list(id)` → `GET /api/leagues/:id/waivers`
  - `api.leagues.waivers.drop(id, playerId)` → `POST /api/leagues/:id/players/:playerId/drop`
  - `api.leagues.waivers.claim(id, droppedPlayerId, dropPlayerId)` → `POST /api/leagues/:id/waivers/claim`
  - `api.leagues.waivers.cancelClaim(id, claimId)` → `DELETE /api/leagues/:id/waivers/claim/:claimId`
  - `api.leagues.waivers.pickup(id, droppedPlayerId)` → `POST /api/leagues/:id/free-agents/:droppedPlayerId/pickup`
  - `api.leagues.waivers.resetPriorities(id)` → `POST /api/leagues/:id/waivers/reset-priorities`
  - `api.leagues.trades.list(id)` → `GET /api/leagues/:id/trades`
  - `api.leagues.trades.propose(id, receivingTeamId, offering, requesting)` → `POST /api/leagues/:id/trades`
  - `api.leagues.trades.accept(id, tradeId)` → `PUT /api/leagues/:id/trades/:tradeId/accept`
  - `api.leagues.trades.reject(id, tradeId)` → `PUT /api/leagues/:id/trades/:tradeId/reject`
  - `api.leagues.trades.counter(id, tradeId, offering, requesting)` → `PUT /api/leagues/:id/trades/:tradeId/counter`
  - `api.leagues.trades.veto(id, tradeId)` → `PUT /api/leagues/:id/trades/:tradeId/veto`

- [ ] **Step 1: Add API methods to `client/src/api.js`**

In `client/src/api.js`, inside the `leagues` object, after the `matchup` block (currently ending around line 157) and before the closing `}` of `leagues`, add:

```js
    waivers: {
      list:           (id) => request(`/api/leagues/${id}/waivers`),
      drop:           (id, playerId) => request(`/api/leagues/${id}/players/${playerId}/drop`, { method: 'POST' }),
      claim:          (id, droppedPlayerId, dropPlayerId) => request(`/api/leagues/${id}/waivers/claim`, {
        method: 'POST', body: JSON.stringify({ dropped_player_id: droppedPlayerId, drop_player_id: dropPlayerId ?? null }),
      }),
      cancelClaim:    (id, claimId) => request(`/api/leagues/${id}/waivers/claim/${claimId}`, { method: 'DELETE' }),
      pickup:         (id, droppedPlayerId) => request(`/api/leagues/${id}/free-agents/${droppedPlayerId}/pickup`, { method: 'POST' }),
      resetPriorities:(id) => request(`/api/leagues/${id}/waivers/reset-priorities`, { method: 'POST' }),
    },

    trades: {
      list:    (id) => request(`/api/leagues/${id}/trades`),
      propose: (id, receivingTeamId, offering, requesting) => request(`/api/leagues/${id}/trades`, {
        method: 'POST', body: JSON.stringify({ receiving_team_id: receivingTeamId, offering, requesting }),
      }),
      accept:  (id, tradeId) => request(`/api/leagues/${id}/trades/${tradeId}/accept`, { method: 'PUT' }),
      reject:  (id, tradeId) => request(`/api/leagues/${id}/trades/${tradeId}/reject`, { method: 'PUT' }),
      counter: (id, tradeId, offering, requesting) => request(`/api/leagues/${id}/trades/${tradeId}/counter`, {
        method: 'PUT', body: JSON.stringify({ offering, requesting }),
      }),
      veto:    (id, tradeId) => request(`/api/leagues/${id}/trades/${tradeId}/veto`, { method: 'PUT' }),
    },
```

- [ ] **Step 2: Add imports and routes to `client/src/App.jsx`**

Add two imports near the other page imports at the top:

```jsx
import WaiverWirePage from './pages/WaiverWirePage.jsx'
import TradesPage from './pages/TradesPage.jsx'
```

Then add two routes nested under `<LeagueLayout>` (alongside the existing schedule/lineup/matchup routes):

```jsx
<Route path="waivers" element={<WaiverWirePage />} />
<Route path="trades" element={<TradesPage />} />
```

- [ ] **Step 3: Add nav links to `client/src/components/LeagueLayout.jsx`**

In `LeagueNav`, add two new `NavLink` entries. Place them between the `Schedule` link and the `Rules` link:

```jsx
<NavLink to={`/leagues/${leagueId}/waivers`} className={tab}>Waivers</NavLink>
<NavLink to={`/leagues/${leagueId}/trades`} className={tab}>Trades</NavLink>
```

The full `LeagueNav` return should now be:

```jsx
  return (
    <div className="league-nav">
      <NavLink end to={`/leagues/${leagueId}`} className={tab}>Home</NavLink>
      <NavLink to={`/leagues/${leagueId}/standings`} className={tab}>Standings</NavLink>
      <NavLink to={`/leagues/${leagueId}/matchup`} className={tab}>Matchup</NavLink>
      <NavLink to={`/leagues/${leagueId}/lineup`} className={tab}>Lineup</NavLink>
      <NavLink to={`/leagues/${leagueId}/schedule`} className={tab}>Schedule</NavLink>
      <NavLink to={`/leagues/${leagueId}/waivers`} className={tab}>Waivers</NavLink>
      <NavLink to={`/leagues/${leagueId}/trades`} className={tab}>Trades</NavLink>
      <NavLink to={`/leagues/${leagueId}/rules`} className={tab}>Rules</NavLink>
      <NavLink to={`/leagues/${leagueId}/players`} className={tab}>Players</NavLink>
      <NavLink to={`/leagues/${leagueId}/add-players`} className={tab}>Add Players</NavLink>
      {isCommissioner && <NavLink to={`/leagues/${leagueId}/admin`} className={tab}>Manage</NavLink>}
    </div>
  )
```

- [ ] **Step 4: Commit**

```bash
git add client/src/api.js client/src/App.jsx client/src/components/LeagueLayout.jsx
git commit -m "feat: add waivers/trades API methods, routes, and nav links"
```

---

### Task 7: WaiverWirePage

**Files:**
- Create: `client/src/pages/WaiverWirePage.jsx`

**Interfaces:**
- Consumes: `api.leagues.waivers.list`, `api.leagues.waivers.claim`, `api.leagues.waivers.cancelClaim`, `api.leagues.waivers.pickup`, `api.leagues.getTeams`, `api.leagues.getStandings`
- `useParams()` → `leagueId`; `useOutletContext()` → `{ league }`; `useAuth()` → `{ user }`

- [ ] **Step 1: Create the page**

```jsx
// client/src/pages/WaiverWirePage.jsx
import { useState, useEffect } from 'react'
import { useParams, useOutletContext } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.jsx'
import { api } from '../api.js'

export default function WaiverWirePage() {
  const { leagueId } = useParams()
  useOutletContext() // league available if needed
  const { user } = useAuth()
  const [data, setData] = useState(null)
  const [myPlayers, setMyPlayers] = useState([])
  const [claimTarget, setClaimTarget] = useState(null)
  const [dropPlayerId, setDropPlayerId] = useState('')
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(true)

  async function load() {
    const [w, teams, standingsData] = await Promise.all([
      api.leagues.waivers.list(leagueId),
      api.leagues.getTeams(leagueId),
      api.leagues.getStandings(leagueId),
    ])
    setData(w)
    const myTeam = teams.find(t => t.user_id === user?.id)
    if (myTeam) {
      const entry = (standingsData?.standings || []).find(s => s.id === myTeam.id)
      setMyPlayers(entry?.players || [])
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [leagueId])

  async function submitClaim() {
    try {
      await api.leagues.waivers.claim(leagueId, claimTarget.id, dropPlayerId ? parseInt(dropPlayerId) : null)
      setMsg('Claim submitted!')
      setClaimTarget(null)
      load()
    } catch (e) { setMsg(e.message) }
  }

  async function handlePickup(dp) {
    try {
      await api.leagues.waivers.pickup(leagueId, dp.id)
      setMsg(`Picked up ${dp.player_name}!`)
      load()
    } catch (e) { setMsg(e.message) }
  }

  async function cancelClaim(claimId) {
    try {
      await api.leagues.waivers.cancelClaim(leagueId, claimId)
      setMsg('Claim cancelled.')
      load()
    } catch (e) { setMsg(e.message) }
  }

  if (loading) return <div className="loading-state"><span className="loading-spinner" /> Loading waivers…</div>

  const waiverPlayers = (data?.players || []).filter(p => p.status === 'waivers')
  const freeAgents = (data?.players || []).filter(p => p.status === 'free_agent')

  return (
    <div className="page-container">
      <h2>Waiver Wire</h2>
      {msg && <div className="alert">{msg}</div>}

      {(data?.myClaims || []).length > 0 && (
        <section style={{ marginBottom: '1.5rem' }}>
          <h3>My Pending Claims</h3>
          {data.myClaims.map(c => (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
              <span>Claim #{c.id} — priority {c.priority_at_time}</span>
              <button onClick={() => cancelClaim(c.id)}>Cancel</button>
            </div>
          ))}
        </section>
      )}

      <section style={{ marginBottom: '1.5rem' }}>
        <h3>On Waivers</h3>
        {waiverPlayers.length === 0
          ? <p className="st-dim">No players on waivers.</p>
          : waiverPlayers.map(p => {
              const meta = JSON.parse(p.player_meta_json || '{}')
              return (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                  <div>
                    <div>{p.player_name} <span className="st-dim">({meta.position})</span></div>
                    <div className="st-dim" style={{ fontSize: '0.8rem' }}>Deadline: {new Date(p.waiver_deadline).toLocaleString()}</div>
                  </div>
                  <button onClick={() => { setClaimTarget(p); setDropPlayerId(''); setMsg('') }}>Claim</button>
                </div>
              )
            })
        }
      </section>

      <section>
        <h3>Free Agents</h3>
        {freeAgents.length === 0
          ? <p className="st-dim">No free agents available.</p>
          : freeAgents.map(p => {
              const meta = JSON.parse(p.player_meta_json || '{}')
              return (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                  <span>{p.player_name} <span className="st-dim">({meta.position})</span></span>
                  <button onClick={() => handlePickup(p)}>Pick Up</button>
                </div>
              )
            })
        }
      </section>

      {claimTarget && (
        <div className="modal-overlay">
          <div className="modal">
            <h3>Claim {claimTarget.player_name}</h3>
            <p>Optionally drop a player to make room:</p>
            <select value={dropPlayerId} onChange={e => setDropPlayerId(e.target.value)}>
              <option value="">— Keep roster as-is —</option>
              {myPlayers.map(p => (
                <option key={p.player_id} value={p.player_id}>{p.player_name}</option>
              ))}
            </select>
            {msg && <div className="alert alert-error" style={{ marginTop: '0.5rem' }}>{msg}</div>}
            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
              <button onClick={submitClaim}>Submit Claim</button>
              <button onClick={() => setClaimTarget(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/pages/WaiverWirePage.jsx
git commit -m "feat: add WaiverWirePage with claim modal and free agent pickup"
```

---

### Task 8: TradesPage + TradeProposalModal

**Files:**
- Create: `client/src/pages/TradesPage.jsx`
- Create: `client/src/components/TradeProposalModal.jsx`

**Interfaces:**
- Consumes: `api.leagues.trades.list`, `api.leagues.trades.accept`, `api.leagues.trades.reject`, `api.leagues.trades.propose`, `api.leagues.getTeams`, `api.leagues.getStandings`
- `useParams()` → `leagueId`; `useAuth()` → `{ user }`

- [ ] **Step 1: Create `TradeProposalModal`**

```jsx
// client/src/components/TradeProposalModal.jsx
import { useState, useEffect } from 'react'
import { api } from '../api.js'

export default function TradeProposalModal({ leagueId, myTeam, teams, onClose, onProposed }) {
  const [step, setStep] = useState(1)
  const [targetTeam, setTargetTeam] = useState(null)
  const [myPlayers, setMyPlayers] = useState([])
  const [theirPlayers, setTheirPlayers] = useState([])
  const [offering, setOffering] = useState([])
  const [requesting, setRequesting] = useState([])
  const [msg, setMsg] = useState('')

  useEffect(() => {
    api.leagues.getStandings(leagueId).then(d => {
      const entry = (d?.standings || []).find(s => s.id === myTeam?.id)
      setMyPlayers(entry?.players || [])
    })
  }, [myTeam])

  async function pickTarget(team) {
    setTargetTeam(team)
    const d = await api.leagues.getStandings(leagueId)
    const entry = (d?.standings || []).find(s => s.id === team.id)
    setTheirPlayers(entry?.players || [])
    setStep(2)
  }

  function toggle(list, setList, pid) {
    setList(prev => prev.includes(pid) ? prev.filter(id => id !== pid) : [...prev, pid])
  }

  async function submit() {
    try {
      await api.leagues.trades.propose(leagueId, targetTeam.id, offering, requesting)
      onProposed()
    } catch (e) { setMsg(e.message) }
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>Propose Trade</h3>
        {msg && <div className="alert alert-error">{msg}</div>}

        {step === 1 && (
          <>
            <p>Trade with which team?</p>
            {teams.map(t => (
              <button key={t.id} onClick={() => pickTarget(t)}
                style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: '0.5rem' }}>
                {t.name}
              </button>
            ))}
            <button onClick={onClose} style={{ marginTop: '1rem' }}>Cancel</button>
          </>
        )}

        {step === 2 && (
          <>
            <p><strong>You offer</strong> (select from your roster):</p>
            {myPlayers.map(p => (
              <label key={p.player_id} style={{ display: 'block', marginBottom: '0.25rem' }}>
                <input type="checkbox" checked={offering.includes(p.player_id)}
                  onChange={() => toggle(offering, setOffering, p.player_id)} />
                {' '}{p.player_name}
              </label>
            ))}
            <p style={{ marginTop: '1rem' }}><strong>You request</strong> (from {targetTeam.name}):</p>
            {theirPlayers.map(p => (
              <label key={p.player_id} style={{ display: 'block', marginBottom: '0.25rem' }}>
                <input type="checkbox" checked={requesting.includes(p.player_id)}
                  onChange={() => toggle(requesting, setRequesting, p.player_id)} />
                {' '}{p.player_name}
              </label>
            ))}
            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
              <button onClick={() => setStep(3)} disabled={offering.length === 0 || requesting.length === 0}>Review</button>
              <button onClick={() => setStep(1)}>Back</button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <p><strong>You offer:</strong> {myPlayers.filter(p => offering.includes(p.player_id)).map(p => p.player_name).join(', ')}</p>
            <p><strong>You request:</strong> {theirPlayers.filter(p => requesting.includes(p.player_id)).map(p => p.player_name).join(', ')}</p>
            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
              <button onClick={submit}>Send Proposal</button>
              <button onClick={() => setStep(2)}>Back</button>
              <button onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create `TradesPage`**

```jsx
// client/src/pages/TradesPage.jsx
import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.jsx'
import { api } from '../api.js'
import TradeProposalModal from '../components/TradeProposalModal.jsx'

export default function TradesPage() {
  const { leagueId } = useParams()
  const { user } = useAuth()
  const [trades, setTrades] = useState([])
  const [teams, setTeams] = useState([])
  const [myTeam, setMyTeam] = useState(null)
  const [showModal, setShowModal] = useState(false)
  const [msg, setMsg] = useState('')

  async function load() {
    const [t, teamsData] = await Promise.all([
      api.leagues.trades.list(leagueId),
      api.leagues.getTeams(leagueId),
    ])
    setTrades(t.trades || [])
    setTeams(teamsData)
    setMyTeam(teamsData.find(t => t.user_id === user?.id) || null)
  }

  useEffect(() => { load() }, [leagueId])

  async function respond(tradeId, action) {
    try {
      await api.leagues.trades[action](leagueId, tradeId)
      setMsg(`Trade ${action}ed.`)
      load()
    } catch (e) { setMsg(e.message) }
  }

  const incoming = trades.filter(t => t.receiving_team_id === myTeam?.id && t.status === 'pending')
  const outgoing = trades.filter(t => t.proposing_team_id === myTeam?.id && t.status === 'pending')
  const history  = trades.filter(t => !['pending'].includes(t.status))

  return (
    <div className="page-container">
      <h2>Trades</h2>
      {msg && <div className="alert">{msg}</div>}
      <button onClick={() => setShowModal(true)} style={{ marginBottom: '1.5rem' }}>+ Propose Trade</button>

      <section style={{ marginBottom: '1.5rem' }}>
        <h3>Incoming Offers ({incoming.length})</h3>
        {incoming.length === 0
          ? <p className="st-dim">No pending offers.</p>
          : incoming.map(t => (
              <TradeCard key={t.id} trade={t}>
                <button onClick={() => respond(t.id, 'accept')}>Accept</button>
                <button onClick={() => respond(t.id, 'reject')}>Reject</button>
              </TradeCard>
            ))
        }
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h3>Outgoing Offers ({outgoing.length})</h3>
        {outgoing.length === 0
          ? <p className="st-dim">No outgoing offers.</p>
          : outgoing.map(t => <TradeCard key={t.id} trade={t} />)
        }
      </section>

      <section>
        <h3>History</h3>
        {history.length === 0
          ? <p className="st-dim">No trade history.</p>
          : history.map(t => <TradeCard key={t.id} trade={t} />)
        }
      </section>

      {showModal && (
        <TradeProposalModal
          leagueId={leagueId}
          myTeam={myTeam}
          teams={teams.filter(t => t.id !== myTeam?.id)}
          onClose={() => setShowModal(false)}
          onProposed={() => { setShowModal(false); load(); setMsg('Trade proposed!') }}
        />
      )}
    </div>
  )
}

function TradeCard({ trade, children }) {
  const offering   = (trade.items || []).filter(i => i.from_team_id === trade.proposing_team_id)
  const requesting = (trade.items || []).filter(i => i.from_team_id === trade.receiving_team_id)
  return (
    <div style={{ padding: '0.75rem 0', borderBottom: '1px solid var(--border)' }}>
      <div>
        <strong>{trade.proposing_team_name}</strong> offers: {offering.map(i => i.player_name).join(', ') || '—'}
      </div>
      <div>
        For <strong>{trade.receiving_team_name}</strong>: {requesting.map(i => i.player_name).join(', ') || '—'}
      </div>
      <div className="st-dim" style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>
        {trade.status} · {new Date(trade.created_at).toLocaleDateString()}
        {trade.veto_deadline && trade.status === 'accepted' && ` · Veto deadline: ${new Date(trade.veto_deadline).toLocaleString()}`}
      </div>
      {children && <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem' }}>{children}</div>}
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/TradesPage.jsx client/src/components/TradeProposalModal.jsx
git commit -m "feat: add TradesPage with inbox/outbox and TradeProposalModal"
```

---

### Task 9: CommissionerDashboard — Veto Panel + Reset Waiver Priorities

**Files:**
- Modify: `client/src/pages/CommissionerDashboard.jsx`

**Interfaces:**
- Consumes: `api.leagues.trades.list` (to show accepted trades awaiting veto), `api.leagues.trades.veto`, `api.leagues.waivers.resetPriorities`
- `useParams()` → `leagueId` (already used in CommissionerDashboard)

- [ ] **Step 1: Read the current CommissionerDashboard to understand existing state structure**

Read `client/src/pages/CommissionerDashboard.jsx` before editing — confirm the existing state variables (schedStartDate, schedWeeks, schedMsg, scheduling) and the `leagueId` source (`useParams()`).

- [ ] **Step 2: Add state for trade veto and priority reset**

In the component body, after existing state declarations, add:

```jsx
  const [pendingTrades, setPendingTrades] = useState([])
  const [vetoMsg, setVetoMsg] = useState('')
  const [priorityMsg, setPriorityMsg] = useState('')
```

- [ ] **Step 3: Add a `useEffect` to load accepted trades**

After existing `useEffect` hooks, add:

```jsx
  useEffect(() => {
    api.leagues.trades.list(leagueId).then(d => {
      setPendingTrades((d.trades || []).filter(t => t.status === 'accepted'))
    }).catch(() => {})
  }, [leagueId])
```

- [ ] **Step 4: Add veto handler**

```jsx
  async function vetoTrade(tradeId) {
    try {
      await api.leagues.trades.veto(leagueId, tradeId)
      setVetoMsg('Trade vetoed.')
      setPendingTrades(prev => prev.filter(t => t.id !== tradeId))
    } catch (e) { setVetoMsg(e.message) }
  }
```

- [ ] **Step 5: Add reset priorities handler**

```jsx
  async function resetPriorities() {
    try {
      await api.leagues.waivers.resetPriorities(leagueId)
      setPriorityMsg('Waiver priorities reset to 0 for all teams.')
    } catch (e) { setPriorityMsg(e.message) }
  }
```

- [ ] **Step 6: Add the two new JSX sections**

In the component's JSX return, after the existing schedule generation form section, add:

```jsx
      <section style={{ marginTop: '2rem' }}>
        <h3>Trade Veto Queue</h3>
        {vetoMsg && <div className="alert">{vetoMsg}</div>}
        {pendingTrades.length === 0
          ? <p className="st-dim">No accepted trades pending veto review.</p>
          : pendingTrades.map(t => {
              const offering   = (t.items || []).filter(i => i.from_team_id === t.proposing_team_id)
              const requesting = (t.items || []).filter(i => i.from_team_id === t.receiving_team_id)
              return (
                <div key={t.id} style={{ padding: '0.75rem 0', borderBottom: '1px solid var(--border)' }}>
                  <div><strong>{t.proposing_team_name}</strong>: {offering.map(i => i.player_name).join(', ')}</div>
                  <div>For <strong>{t.receiving_team_name}</strong>: {requesting.map(i => i.player_name).join(', ')}</div>
                  <div className="st-dim" style={{ fontSize: '0.8rem' }}>
                    Veto deadline: {new Date(t.veto_deadline).toLocaleString()}
                  </div>
                  <button onClick={() => vetoTrade(t.id)} style={{ marginTop: '0.5rem' }}>Veto Trade</button>
                </div>
              )
            })
        }
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h3>Waiver Priorities</h3>
        {priorityMsg && <div className="alert">{priorityMsg}</div>}
        <p className="st-dim">Resets all team waiver priorities to 0 (equal standing).</p>
        <button onClick={resetPriorities}>Reset Waiver Priorities</button>
      </section>
```

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/CommissionerDashboard.jsx
git commit -m "feat: add trade veto panel and reset waiver priorities to commissioner dashboard"
```

---

## Self-Review

### 1. Spec Coverage

| Spec Requirement | Task |
|-----------------|------|
| dropped_players, waiver_claims, trade_proposals, trade_items tables | Task 1 |
| 24h waiver deadline on drop | Task 2 |
| GET /waivers (waivers + free_agent status) | Task 2 |
| POST /waivers/claim with priority_at_time snapshot | Task 3 |
| DELETE /waivers/claim/:id (cancel) | Task 3 |
| POST /free-agents/:id/pickup (instant) | Task 3 |
| Cron: waiver processing by priority, winner gets last priority | Task 5 |
| Cron: unclaimed → free_agent | Task 5 |
| GET /trades | Task 4 |
| POST /trades (propose, 48h expiry) | Task 4 |
| PUT /trades/:id/accept (sets veto_deadline from config) | Task 4 |
| PUT /trades/:id/reject | Task 4 |
| PUT /trades/:id/counter (new trade row, roles swapped) | Task 4 |
| PUT /trades/:id/veto (commissioner) | Task 4 |
| Cron: trade execution after veto_deadline passes | Task 5 |
| Cron: expire pending trades past expires_at | Task 5 |
| trade_veto_hours config default (24) | Task 1 |
| WaiverWirePage | Task 7 |
| TradesPage + TradeProposalModal (multi-step) | Task 8 |
| CommissionerDashboard: veto panel | Task 9 |
| CommissionerDashboard: reset waiver priorities | Task 9 |

All spec requirements covered. ✅

### 2. Placeholder Scan

No TBDs, no "handle edge cases" vague steps, no forward references to undefined types. ✅

### 3. Type Consistency

- `api.leagues.waivers.claim(id, droppedPlayerId, dropPlayerId)` — used in Task 7 with `claimTarget.id` (number from `dropped_players.id`), matches Task 6 definition. ✅
- `api.leagues.trades.propose(id, receivingTeamId, offering, requesting)` — used in TradeProposalModal with `targetTeam.id` and `offering`/`requesting` arrays of `player_id` numbers, matches Task 6 definition. ✅
- `api.leagues.trades[action](leagueId, tradeId)` — used in TradesPage `respond()`, valid for `accept`/`reject` which take only `(id, tradeId)`. ✅
- `processWaivers(db, leagueId)` and `executeTrades(db, leagueId)` — called in cron loop with `(db, league.id)`. ✅
