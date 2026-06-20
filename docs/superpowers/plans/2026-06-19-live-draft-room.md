# Live Draft Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real-time snake draft room backed by a Cloudflare Durable Object, with per-team pre-rank queues, a server-side pick timer, commissioner controls, and auto-pick by position need.

**Architecture:** One `DraftRoom` Durable Object per league (keyed `league-{leagueId}`) holds in-memory draft state and a `Map<WebSocket, sender>` of connected clients. The DO uses the Alarm API for an authoritative server-side timer and writes to D1 on every pick. The Worker proxies WebSocket upgrades to the DO and handles all REST setup routes.

**Tech Stack:** Cloudflare Workers, Durable Objects, D1 (SQLite), React 18, React Router v6.

## Global Constraints

- All new worker routes go inside `handleApi` before the `// ── Waivers` comment (line ~1135 of `worker/index.js`)
- Route pattern: `const xMatch = pathname.match(/^\/api\/.../); if (xMatch && request.method === 'METHOD') { ... }`
- All league-scoped routes: `loadLeagueContext(db, request, leagueId)` then `if (ctx.error) return ctx.error`
- `parseId(value)` converts route param strings to integers
- `isCommissioner(ctx.league, ctx.role, ctx.user.id)` for commissioner gates
- `mergeConfig(ctx.league.config_json)` for league config (now includes `pick_timer_seconds: 90`)
- `team_players` inserts must include `position_detail = ''`
- `normalizeHeadshotUrl(url)` already defined in `worker/index.js` — call it for NHL API headshot URLs
- `DraftRoom` class must be exported from `worker/draft-room.js` AND re-exported from `worker/index.js`
- Syntax check after every worker change: `node --check worker/draft-room.js && node --check worker/index.js`
- Frontend: `useParams()` for `leagueId`, `useOutletContext()` for `{ user }`, `useAuth()` for auth state
- No new npm dependencies

---

### Task 1: Migration 0013 + wrangler.toml DO binding + config defaults

**Files:**
- Create: `migrations/0013_draft.sql`
- Modify: `wrangler.toml`
- Modify: `worker/index.js` lines 225–270 (DEFAULT_LEAGUE_CONFIG + mergeConfig)

**Interfaces:**
- Produces: 4 new D1 tables (`draft_sessions`, `draft_picks`, `draft_queues`, `draft_player_rankings`), DO binding `env.DRAFT_ROOM`, config key `pick_timer_seconds`

- [ ] **Step 1: Create migration**

Create `migrations/0013_draft.sql`:

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS draft_sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id         INTEGER NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'pending',
  draft_order_json  TEXT NOT NULL DEFAULT '[]',
  current_pick      INTEGER NOT NULL DEFAULT 0,
  total_picks       INTEGER NOT NULL DEFAULT 0,
  pick_deadline     DATETIME,
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

- [ ] **Step 2: Add DO binding and migration to wrangler.toml**

Open `wrangler.toml`. After the `[triggers]` block, add:

```toml
[[durable_objects.bindings]]
name = "DRAFT_ROOM"
class_name = "DraftRoom"

[[migrations]]
tag = "v1"
new_classes = ["DraftRoom"]
```

- [ ] **Step 3: Add pick_timer_seconds to DEFAULT_LEAGUE_CONFIG**

In `worker/index.js`, find `DEFAULT_LEAGUE_CONFIG` (line ~225). Add `pick_timer_seconds: 90` after `trade_veto_hours: 24`:

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
  pick_timer_seconds: 90,
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

In `mergeConfig`, add `pick_timer_seconds: parsed.pick_timer_seconds ?? d.pick_timer_seconds` after the `trade_veto_hours` line:

```js
    trade_veto_hours: parsed.trade_veto_hours ?? d.trade_veto_hours,
    pick_timer_seconds: parsed.pick_timer_seconds ?? d.pick_timer_seconds,
```

- [ ] **Step 4: Syntax check**

```bash
node --check worker/index.js
```
Expected: no output (exit 0).

- [ ] **Step 5: Commit**

```bash
git add migrations/0013_draft.sql wrangler.toml worker/index.js
git commit -m "feat: migration 0013 draft tables, DO binding, pick_timer_seconds config"
```

---

### Task 2: DraftRoom Durable Object

**Files:**
- Create: `worker/draft-room.js`
- Modify: `worker/index.js` (add import + re-export at top and bottom)

**Interfaces:**
- Consumes: `env.DB` (D1), tables from Task 1, `normalizeHeadshotUrl` not available inside DO (define a local inline version)
- Produces: `DraftRoom` class exported from `worker/draft-room.js`; WS endpoint handles messages `pick`, `queue_add`, `queue_remove`, `queue_reorder`, `pause`, `resume`; internal HTTP endpoints `/alarm-reset` and `/pause`

- [ ] **Step 1: Create worker/draft-room.js**

```js
export class DraftRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.initialized = false;
    this.draftSessionId = null;
    this.leagueId = null;
    this.status = 'pending';
    this.draftOrder = [];
    this.numTeams = 0;
    this.currentPick = 0;
    this.totalPicks = 0;
    this.timerSeconds = 90;
    this.pickDeadline = null; // ms timestamp

    this.capsF = 10;
    this.capsD = 5;
    this.capsG = 3;

    this.pickedPlayerIds = new Set();
    this.picks = [];
    this.teamRosters = new Map(); // teamId -> {F,D,G counts}
    this.queues = new Map();      // teamId -> [{playerId,playerName,position,nhlTeam,headshotUrl,crestUrl}]
    this.globalRankings = [];     // ordered by global_rank
    this.teamNames = new Map();   // teamId -> name

    this.clients = new Map();     // WebSocket -> {teamId,userId,isCommissioner}
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/pause' && request.method === 'POST') {
      await this.state.storage.deleteAlarm();
      this.status = 'paused';
      this.broadcastAll();
      return new Response('ok');
    }

    if (url.pathname === '/alarm-reset' && request.method === 'POST') {
      const leagueId = parseInt(request.headers.get('X-League-Id') || '0');
      if (!this.initialized) await this.rehydrate(leagueId);
      // Re-read status from D1 (may have been updated by REST resume route)
      if (this.draftSessionId) {
        const row = await this.env.DB.prepare(
          'SELECT status, pick_deadline FROM draft_sessions WHERE id = ?'
        ).bind(this.draftSessionId).first();
        if (row) {
          this.status = row.status;
          this.pickDeadline = row.pick_deadline ? new Date(row.pick_deadline).getTime() : null;
        }
      }
      if (this.status === 'active' && this.currentPick < this.totalPicks) {
        const deadline = this.pickDeadline || (Date.now() + this.timerSeconds * 1000);
        await this.state.storage.setAlarm(deadline);
      }
      this.broadcastAll();
      return new Response('ok');
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const leagueId = parseInt(request.headers.get('X-League-Id') || '0');
    const userId = parseInt(request.headers.get('X-User-Id') || '0');
    const teamId = parseInt(request.headers.get('X-Team-Id') || '0') || null;
    const isCommissioner = request.headers.get('X-Is-Commissioner') === 'true';

    if (!this.initialized) await this.rehydrate(leagueId);

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();

    this.clients.set(server, { teamId, userId, isCommissioner });

    server.addEventListener('message', async (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        await this.handleMessage(server, { teamId, userId, isCommissioner }, msg);
      } catch {
        this.send(server, { type: 'error', message: 'Invalid message' });
      }
    });

    server.addEventListener('close', () => this.clients.delete(server));
    server.addEventListener('error', () => this.clients.delete(server));

    this.send(server, { type: 'state', data: this.snapshot(server) });

    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm() {
    if (this.status !== 'active') return;
    if (this.currentPick >= this.totalPicks) return;
    await this.autoPickForCurrentTeam();
  }

  async rehydrate(leagueId) {
    this.leagueId = leagueId;

    const session = await this.env.DB.prepare(
      'SELECT * FROM draft_sessions WHERE league_id = ?'
    ).bind(leagueId).first();

    if (!session) { this.initialized = true; return; }

    this.draftSessionId = session.id;
    this.status = session.status;
    this.draftOrder = JSON.parse(session.draft_order_json || '[]');
    this.numTeams = this.draftOrder.length;
    this.currentPick = session.current_pick;
    this.totalPicks = session.total_picks;
    this.pickDeadline = session.pick_deadline ? new Date(session.pick_deadline).getTime() : null;

    const league = await this.env.DB.prepare(
      'SELECT config_json FROM leagues WHERE id = ?'
    ).bind(leagueId).first();
    const config = JSON.parse(league?.config_json || '{}');
    this.timerSeconds = config.pick_timer_seconds ?? 90;
    this.capsF = config.roster?.maxF ?? 10;
    this.capsD = config.roster?.maxD ?? 5;
    this.capsG = config.roster?.maxG ?? 3;

    // Team names
    if (this.draftOrder.length > 0) {
      const ph = this.draftOrder.map(() => '?').join(',');
      const { results: teams } = await this.env.DB.prepare(
        `SELECT id, name FROM teams WHERE id IN (${ph})`
      ).bind(...this.draftOrder).all();
      for (const t of (teams || [])) this.teamNames.set(t.id, t.name);
    }

    // Picks
    const { results: pickRows } = await this.env.DB.prepare(
      'SELECT * FROM draft_picks WHERE draft_session_id = ? ORDER BY overall_pick'
    ).bind(this.draftSessionId).all();

    for (const p of (pickRows || [])) {
      this.pickedPlayerIds.add(p.player_id);
      const meta = JSON.parse(p.player_meta_json || '{}');
      const pos = meta.position || 'F';

      if (!this.teamRosters.has(p.team_id)) this.teamRosters.set(p.team_id, { F: 0, D: 0, G: 0 });
      const roster = this.teamRosters.get(p.team_id);
      roster[pos] = (roster[pos] || 0) + 1;

      this.picks.push({
        teamId: p.team_id,
        teamName: this.teamNames.get(p.team_id) || '',
        playerId: p.player_id,
        playerName: p.player_name,
        position: pos,
        nhlTeam: meta.nhl_team || '',
        headshotUrl: meta.headshot_url || '',
        round: p.round,
        pickInRound: p.pick_in_round,
        overallPick: p.overall_pick,
        isAutoPick: !!p.is_auto_pick,
        pickedAt: p.picked_at,
      });
    }

    for (const tid of this.draftOrder) {
      if (!this.teamRosters.has(tid)) this.teamRosters.set(tid, { F: 0, D: 0, G: 0 });
    }

    // Queues
    const { results: queueRows } = await this.env.DB.prepare(
      'SELECT team_id, player_id, player_name, player_meta_json FROM draft_queues WHERE draft_session_id = ? ORDER BY team_id, rank_order'
    ).bind(this.draftSessionId).all();

    for (const row of (queueRows || [])) {
      if (!this.queues.has(row.team_id)) this.queues.set(row.team_id, []);
      const meta = JSON.parse(row.player_meta_json || '{}');
      this.queues.get(row.team_id).push({
        playerId: row.player_id, playerName: row.player_name,
        position: meta.position || '', nhlTeam: meta.nhl_team || '',
        headshotUrl: meta.headshot_url || '', crestUrl: meta.crest_url || '',
      });
    }

    // Global rankings
    const { results: rankRows } = await this.env.DB.prepare(
      'SELECT player_id, player_name, player_meta_json FROM draft_player_rankings WHERE draft_session_id = ? ORDER BY global_rank'
    ).bind(this.draftSessionId).all();

    this.globalRankings = (rankRows || []).map(r => {
      const meta = JSON.parse(r.player_meta_json || '{}');
      return {
        playerId: r.player_id, playerName: r.player_name,
        position: meta.position || '', nhlTeam: meta.nhl_team || '',
        headshotUrl: meta.headshot_url || '', crestUrl: meta.crest_url || '',
      };
    });

    this.initialized = true;
  }

  async handleMessage(ws, sender, msg) {
    switch (msg.type) {
      case 'pick':          return this.handlePick(ws, sender, msg);
      case 'queue_add':     return this.handleQueueAdd(ws, sender, msg);
      case 'queue_remove':  return this.handleQueueRemove(ws, sender, msg);
      case 'queue_reorder': return this.handleQueueReorder(ws, sender, msg);
      case 'pause':         return this.handlePause(ws, sender);
      case 'resume':        return this.handleResume(ws, sender);
      default: this.send(ws, { type: 'error', message: `Unknown type: ${msg.type}` });
    }
  }

  async handlePick(ws, sender, msg) {
    if (this.status !== 'active') return this.send(ws, { type: 'error', message: 'Draft not active' });
    if (this.currentPick >= this.totalPicks) return this.send(ws, { type: 'error', message: 'Draft complete' });

    const currentTeamId = this.getCurrentTeamId();
    if (!sender.teamId || sender.teamId !== currentTeamId) {
      return this.send(ws, { type: 'error', message: 'Not your turn' });
    }

    const { playerId, playerName, playerMeta = {} } = msg;
    if (!playerId || !playerName) return this.send(ws, { type: 'error', message: 'playerId and playerName required' });
    if (this.pickedPlayerIds.has(playerId)) return this.send(ws, { type: 'error', message: 'Player already drafted' });

    const pos = playerMeta.position || 'F';
    const roster = this.teamRosters.get(currentTeamId) || { F: 0, D: 0, G: 0 };
    const cap = pos === 'G' ? this.capsG : pos === 'D' ? this.capsD : this.capsF;
    if ((roster[pos] || 0) >= cap) {
      return this.send(ws, { type: 'error', message: `Roster full for position ${pos}` });
    }

    await this.executePick(currentTeamId, { playerId, playerName, playerMeta }, false);
  }

  async executePick(teamId, { playerId, playerName, playerMeta = {} }, isAutoPick) {
    const pos = playerMeta.position || 'F';
    const overall = this.currentPick;
    const round = Math.floor(overall / this.numTeams) + 1;
    const pickInRound = overall % this.numTeams;
    const now = new Date().toISOString();
    const metaJson = JSON.stringify({
      position: pos,
      nhl_team: playerMeta.nhlTeam || playerMeta.nhl_team || '',
      headshot_url: playerMeta.headshotUrl || playerMeta.headshot_url || '',
      crest_url: playerMeta.crestUrl || playerMeta.crest_url || '',
    });

    const nextPick = overall + 1;
    const nextDeadline = nextPick < this.totalPicks
      ? new Date(Date.now() + this.timerSeconds * 1000).toISOString()
      : null;

    await this.env.DB.batch([
      this.env.DB.prepare(`
        INSERT INTO draft_picks
          (draft_session_id, league_id, team_id, player_id, player_name, player_meta_json,
           round, pick_in_round, overall_pick, is_auto_pick, picked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(this.draftSessionId, this.leagueId, teamId, playerId, playerName, metaJson,
              round, pickInRound, overall, isAutoPick ? 1 : 0, now),
      this.env.DB.prepare(
        'UPDATE draft_sessions SET current_pick = ?, pick_deadline = ? WHERE id = ?'
      ).bind(nextPick, nextDeadline, this.draftSessionId),
      this.env.DB.prepare(`
        INSERT OR IGNORE INTO team_players
          (team_id, player_id, player_name, nhl_team, position, position_detail, headshot_url, crest_url)
        VALUES (?, ?, ?, ?, ?, '', ?, ?)
      `).bind(teamId, playerId, playerName,
              playerMeta.nhlTeam || playerMeta.nhl_team || '', pos,
              playerMeta.headshotUrl || playerMeta.headshot_url || '',
              playerMeta.crestUrl || playerMeta.crest_url || ''),
    ]);

    // Update in-memory
    this.pickedPlayerIds.add(playerId);
    const roster = this.teamRosters.get(teamId) || { F: 0, D: 0, G: 0 };
    roster[pos] = (roster[pos] || 0) + 1;
    this.teamRosters.set(teamId, roster);

    this.picks.push({
      teamId, teamName: this.teamNames.get(teamId) || '',
      playerId, playerName, position: pos,
      nhlTeam: playerMeta.nhlTeam || playerMeta.nhl_team || '',
      headshotUrl: playerMeta.headshotUrl || playerMeta.headshot_url || '',
      round, pickInRound, overallPick: overall, isAutoPick, pickedAt: now,
    });

    this.currentPick = nextPick;

    if (nextPick >= this.totalPicks) {
      this.status = 'completed';
      this.pickDeadline = null;
      await this.env.DB.prepare(
        "UPDATE draft_sessions SET status = 'completed', completed_at = ? WHERE id = ?"
      ).bind(now, this.draftSessionId).run();
      await this.state.storage.deleteAlarm();
    } else {
      this.pickDeadline = Date.now() + this.timerSeconds * 1000;
      await this.state.storage.setAlarm(this.pickDeadline);
    }

    this.broadcastAll();
  }

  async autoPickForCurrentTeam() {
    const teamId = this.getCurrentTeamId();
    if (!teamId) return;

    const positions = this.getPositionsInNeedOrder(teamId);
    let candidate = null;

    for (const pos of positions) {
      candidate = this.firstUndraftedInQueue(teamId, pos)
               || this.firstUndraftedInRankings(pos);
      if (candidate) break;
    }

    if (!candidate) {
      this.status = 'completed';
      const now = new Date().toISOString();
      await this.env.DB.prepare(
        "UPDATE draft_sessions SET status = 'completed', completed_at = ? WHERE id = ?"
      ).bind(now, this.draftSessionId).run();
      this.broadcastAll();
      return;
    }

    await this.executePick(teamId, candidate, true);
  }

  getPositionsInNeedOrder(teamId) {
    const r = this.teamRosters.get(teamId) || { F: 0, D: 0, G: 0 };
    return [
      { pos: 'F', frac: (this.capsF - (r.F || 0)) / this.capsF },
      { pos: 'D', frac: (this.capsD - (r.D || 0)) / this.capsD },
      { pos: 'G', frac: (this.capsG - (r.G || 0)) / this.capsG },
    ]
      .filter(p => p.frac > 0)
      .sort((a, b) => b.frac - a.frac)
      .map(p => p.pos);
  }

  firstUndraftedInQueue(teamId, position) {
    const queue = this.queues.get(teamId) || [];
    const e = queue.find(p => p.position === position && !this.pickedPlayerIds.has(p.playerId));
    if (!e) return null;
    return { playerId: e.playerId, playerName: e.playerName, playerMeta: { position: e.position, nhlTeam: e.nhlTeam, headshotUrl: e.headshotUrl, crestUrl: e.crestUrl } };
  }

  firstUndraftedInRankings(position) {
    const e = this.globalRankings.find(p => p.position === position && !this.pickedPlayerIds.has(p.playerId));
    if (!e) return null;
    return { playerId: e.playerId, playerName: e.playerName, playerMeta: { position: e.position, nhlTeam: e.nhlTeam, headshotUrl: e.headshotUrl, crestUrl: e.crestUrl } };
  }

  async handleQueueAdd(ws, sender, msg) {
    if (!sender.teamId) return this.send(ws, { type: 'error', message: 'No team' });
    const { playerId, playerName, playerMeta = {} } = msg;
    if (!playerId || !playerName) return;

    const queue = this.queues.get(sender.teamId) || [];
    if (queue.some(p => p.playerId === playerId)) return;

    const entry = {
      playerId, playerName,
      position: playerMeta.position || '', nhlTeam: playerMeta.nhlTeam || '',
      headshotUrl: playerMeta.headshotUrl || '', crestUrl: playerMeta.crestUrl || '',
    };
    queue.push(entry);
    this.queues.set(sender.teamId, queue);

    this.env.DB.prepare(`
      INSERT OR IGNORE INTO draft_queues
        (draft_session_id, team_id, player_id, player_name, player_meta_json, rank_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      this.draftSessionId, sender.teamId, playerId, playerName,
      JSON.stringify({ position: entry.position, nhl_team: entry.nhlTeam, headshot_url: entry.headshotUrl, crest_url: entry.crestUrl }),
      queue.length
    ).run().catch(console.error);

    this.send(ws, { type: 'state', data: this.snapshot(ws) });
  }

  async handleQueueRemove(ws, sender, msg) {
    if (!sender.teamId) return;
    const { playerId } = msg;
    const queue = (this.queues.get(sender.teamId) || []).filter(p => p.playerId !== playerId);
    this.queues.set(sender.teamId, queue);
    this.persistQueue(sender.teamId).catch(console.error);
    this.send(ws, { type: 'state', data: this.snapshot(ws) });
  }

  async handleQueueReorder(ws, sender, msg) {
    if (!sender.teamId) return;
    const { playerIds } = msg;
    if (!Array.isArray(playerIds)) return;
    const byId = new Map((this.queues.get(sender.teamId) || []).map(p => [p.playerId, p]));
    this.queues.set(sender.teamId, playerIds.map(id => byId.get(id)).filter(Boolean));
    this.persistQueue(sender.teamId).catch(console.error);
    this.send(ws, { type: 'state', data: this.snapshot(ws) });
  }

  async persistQueue(teamId) {
    const queue = this.queues.get(teamId) || [];
    await this.env.DB.batch([
      this.env.DB.prepare(
        'DELETE FROM draft_queues WHERE draft_session_id = ? AND team_id = ?'
      ).bind(this.draftSessionId, teamId),
      ...queue.map((p, i) => this.env.DB.prepare(`
        INSERT INTO draft_queues
          (draft_session_id, team_id, player_id, player_name, player_meta_json, rank_order)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        this.draftSessionId, teamId, p.playerId, p.playerName,
        JSON.stringify({ position: p.position, nhl_team: p.nhlTeam, headshot_url: p.headshotUrl, crest_url: p.crestUrl }),
        i + 1
      )),
    ]);
  }

  async handlePause(ws, sender) {
    if (!sender.isCommissioner) return this.send(ws, { type: 'error', message: 'Commissioner only' });
    if (this.status !== 'active') return;
    await this.state.storage.deleteAlarm();
    this.status = 'paused';
    await this.env.DB.prepare(
      "UPDATE draft_sessions SET status = 'paused' WHERE id = ?"
    ).bind(this.draftSessionId).run();
    this.broadcastAll();
  }

  async handleResume(ws, sender) {
    if (!sender.isCommissioner) return this.send(ws, { type: 'error', message: 'Commissioner only' });
    if (this.status !== 'paused') return;
    this.pickDeadline = Date.now() + this.timerSeconds * 1000;
    this.status = 'active';
    const deadlineISO = new Date(this.pickDeadline).toISOString();
    await this.state.storage.setAlarm(this.pickDeadline);
    await this.env.DB.prepare(
      "UPDATE draft_sessions SET status = 'active', pick_deadline = ? WHERE id = ?"
    ).bind(deadlineISO, this.draftSessionId).run();
    this.broadcastAll();
  }

  getCurrentTeamId() {
    if (this.numTeams === 0 || this.currentPick >= this.totalPicks) return null;
    const round = Math.floor(this.currentPick / this.numTeams) + 1;
    const pickInRound = this.currentPick % this.numTeams;
    const idx = (round % 2 === 1) ? pickInRound : (this.numTeams - 1 - pickInRound);
    return this.draftOrder[idx] ?? null;
  }

  send(ws, data) {
    try { ws.send(JSON.stringify(data)); } catch {}
  }

  broadcastAll() {
    for (const [ws] of this.clients) {
      this.send(ws, { type: 'state', data: this.snapshot(ws) });
    }
  }

  snapshot(ws) {
    const sender = this.clients.get(ws);
    return {
      status: this.status,
      currentPick: this.currentPick,
      totalPicks: this.totalPicks,
      currentTeamId: this.getCurrentTeamId(),
      pickDeadline: this.pickDeadline ? new Date(this.pickDeadline).toISOString() : null,
      draftOrder: this.draftOrder.map(id => ({ teamId: id, teamName: this.teamNames.get(id) || '' })),
      picks: this.picks,
      myQueue: sender?.teamId ? (this.queues.get(sender.teamId) || []) : [],
      available: this.globalRankings.filter(p => !this.pickedPlayerIds.has(p.playerId)).slice(0, 50),
    };
  }
}
```

- [ ] **Step 2: Re-export DraftRoom from worker/index.js**

At the very top of `worker/index.js` (after the existing imports), add:

```js
export { DraftRoom } from './draft-room.js';
```

- [ ] **Step 3: Syntax check**

```bash
node --check worker/draft-room.js && node --check worker/index.js
```
Expected: no output (exit 0).

- [ ] **Step 4: Commit**

```bash
git add worker/draft-room.js worker/index.js
git commit -m "feat: DraftRoom Durable Object — WS lifecycle, pick processing, timer, auto-pick"
```

---

### Task 3: Worker REST routes for draft

**Files:**
- Modify: `worker/index.js` — add draft routes before the `// ── Waivers` comment (~line 1135)

**Interfaces:**
- Consumes: `DraftRoom` via `env.DRAFT_ROOM` binding, `mergeConfig`, `loadLeagueContext`, `parseId`, `isCommissioner`, `normalizeHeadshotUrl`, `NHL_BASE`
- Produces: REST routes listed below; `env.DRAFT_ROOM` available in `handleApi` because `handleApi(request, env, pathname)` receives `env`

- [ ] **Step 1: Add draft routes to worker/index.js**

In `worker/index.js`, find the comment `// ── Waivers` (around line 1135). Insert the following block immediately before it:

```js
  // ── Draft ────────────────────────────────────────────────────────────────

  const draftSessionMatch = pathname.match(/^\/api\/leagues\/(\d+)\/draft\/session$/);

  if (draftSessionMatch && request.method === 'POST') {
    const leagueId = parseId(draftSessionMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id)) return json({ error: 'Commissioner only' }, { status: 403 });

    const existing = await db.prepare('SELECT id, status FROM draft_sessions WHERE league_id = ?').bind(leagueId).first();
    if (existing && existing.status !== 'pending') {
      return json({ error: 'A draft session already exists and cannot be reset' }, { status: 400 });
    }
    if (existing) {
      await db.prepare('UPDATE draft_sessions SET draft_order_json = ?, current_pick = 0, total_picks = 0, pick_deadline = NULL WHERE id = ?')
        .bind('[]', existing.id).run();
      return json({ id: existing.id });
    }
    const session = await db.prepare('INSERT INTO draft_sessions (league_id) VALUES (?) RETURNING id').bind(leagueId).first();
    return json({ id: session.id });
  }

  if (draftSessionMatch && request.method === 'GET') {
    const leagueId = parseId(draftSessionMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;

    const session = await db.prepare('SELECT * FROM draft_sessions WHERE league_id = ?').bind(leagueId).first();
    if (!session) return json({ session: null, picks: [], myQueue: [] });

    const { results: picks } = await db.prepare(`
      SELECT dp.*, t.name AS team_name FROM draft_picks dp
      JOIN teams t ON t.id = dp.team_id
      WHERE dp.draft_session_id = ? ORDER BY dp.overall_pick
    `).bind(session.id).all();

    const myTeam = await db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id = ?').bind(leagueId, ctx.user.id).first();
    const myQueue = myTeam
      ? (await db.prepare('SELECT * FROM draft_queues WHERE draft_session_id = ? AND team_id = ? ORDER BY rank_order').bind(session.id, myTeam.id).all()).results || []
      : [];

    const draftOrder = JSON.parse(session.draft_order_json || '[]');
    let teamNames = {};
    if (draftOrder.length > 0) {
      const ph = draftOrder.map(() => '?').join(',');
      const { results: tms } = await db.prepare(`SELECT id, name FROM teams WHERE id IN (${ph})`).bind(...draftOrder).all();
      teamNames = Object.fromEntries((tms || []).map(t => [t.id, t.name]));
    }

    return json({
      session: { ...session, draft_order: draftOrder.map(id => ({ teamId: id, teamName: teamNames[id] || '' })) },
      picks: (picks || []).map(p => ({ ...p, player_meta: JSON.parse(p.player_meta_json || '{}') })),
      myQueue: myQueue.map(q => ({ ...q, player_meta: JSON.parse(q.player_meta_json || '{}') })),
    });
  }

  const draftOrderMatch = pathname.match(/^\/api\/leagues\/(\d+)\/draft\/session\/order$/);
  if (draftOrderMatch && request.method === 'PUT') {
    const leagueId = parseId(draftOrderMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id)) return json({ error: 'Commissioner only' }, { status: 403 });

    const { order } = await request.json();
    if (!Array.isArray(order) || order.length === 0) return json({ error: 'order must be a non-empty array of teamIds' }, { status: 400 });

    const { results: teams } = await db.prepare('SELECT id FROM teams WHERE league_id = ?').bind(leagueId).all();
    const validIds = new Set((teams || []).map(t => t.id));
    if (!order.every(id => validIds.has(id))) return json({ error: 'Invalid team ID in order' }, { status: 400 });

    const session = await db.prepare('SELECT id, status FROM draft_sessions WHERE league_id = ?').bind(leagueId).first();
    if (!session) return json({ error: 'No draft session found' }, { status: 404 });
    if (session.status !== 'pending') return json({ error: 'Draft already started' }, { status: 400 });

    await db.prepare('UPDATE draft_sessions SET draft_order_json = ? WHERE id = ?').bind(JSON.stringify(order), session.id).run();
    return json({ ok: true });
  }

  const draftRandomizeMatch = pathname.match(/^\/api\/leagues\/(\d+)\/draft\/session\/randomize$/);
  if (draftRandomizeMatch && request.method === 'POST') {
    const leagueId = parseId(draftRandomizeMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id)) return json({ error: 'Commissioner only' }, { status: 403 });

    const session = await db.prepare('SELECT id, status FROM draft_sessions WHERE league_id = ?').bind(leagueId).first();
    if (!session) return json({ error: 'No draft session found' }, { status: 404 });
    if (session.status !== 'pending') return json({ error: 'Draft already started' }, { status: 400 });

    const { results: teams } = await db.prepare('SELECT id FROM teams WHERE league_id = ?').bind(leagueId).all();
    const order = (teams || []).map(t => t.id).sort(() => Math.random() - 0.5);
    await db.prepare('UPDATE draft_sessions SET draft_order_json = ? WHERE id = ?').bind(JSON.stringify(order), session.id).run();
    return json({ order });
  }

  const draftStartMatch = pathname.match(/^\/api\/leagues\/(\d+)\/draft\/session\/start$/);
  if (draftStartMatch && request.method === 'POST') {
    const leagueId = parseId(draftStartMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id)) return json({ error: 'Commissioner only' }, { status: 403 });

    const session = await db.prepare('SELECT * FROM draft_sessions WHERE league_id = ?').bind(leagueId).first();
    if (!session) return json({ error: 'No draft session found' }, { status: 404 });
    if (session.status !== 'pending') return json({ error: 'Draft already started' }, { status: 400 });

    const draftOrder = JSON.parse(session.draft_order_json || '[]');
    if (draftOrder.length === 0) return json({ error: 'Draft order not set' }, { status: 400 });

    const config = mergeConfig(ctx.league.config_json);
    const rounds = config.roster.maxF + config.roster.maxD + config.roster.maxG;
    const totalPicks = rounds * draftOrder.length;
    const timerSeconds = config.pick_timer_seconds;
    const pickDeadline = new Date(Date.now() + timerSeconds * 1000).toISOString();

    // Seed rankings from NHL API — best effort, non-blocking on failure
    const rankInserts = [];
    let globalRank = 1;
    try {
      const skaterRes = await fetch(`${NHL_BASE}/skater-stats-leaders/current?categories=points&limit=200`, {
        headers: { 'User-Agent': 'PlayoffFantasy/1.0' },
      });
      if (skaterRes.ok) {
        const skaterData = await skaterRes.json();
        // The API returns the top players under a key matching the category name
        const skaters = skaterData.skaterPoints || skaterData.data || [];
        for (const s of skaters) {
          const posCode = s.positionCode || '';
          const position = posCode === 'D' ? 'D' : 'F';
          const name = s.name?.default || `${s.firstName?.default || ''} ${s.lastName?.default || ''}`.trim();
          const meta = JSON.stringify({
            position, nhl_team: s.teamAbbrevs || '',
            headshot_url: normalizeHeadshotUrl(s.headshot), crest_url: '',
          });
          rankInserts.push(db.prepare(`
            INSERT OR IGNORE INTO draft_player_rankings (draft_session_id, player_id, player_name, player_meta_json, global_rank)
            VALUES (?, ?, ?, ?, ?)
          `).bind(session.id, s.id || s.playerId, name, meta, globalRank++));
        }
      }
      const goalieRes = await fetch(`${NHL_BASE}/goalie-stats-leaders/current?categories=wins&limit=30`, {
        headers: { 'User-Agent': 'PlayoffFantasy/1.0' },
      });
      if (goalieRes.ok) {
        const goalieData = await goalieRes.json();
        const goalies = goalieData.goalieWins || goalieData.data || [];
        for (const g of goalies) {
          const name = g.name?.default || `${g.firstName?.default || ''} ${g.lastName?.default || ''}`.trim();
          const meta = JSON.stringify({
            position: 'G', nhl_team: g.teamAbbrevs || '',
            headshot_url: normalizeHeadshotUrl(g.headshot), crest_url: '',
          });
          rankInserts.push(db.prepare(`
            INSERT OR IGNORE INTO draft_player_rankings (draft_session_id, player_id, player_name, player_meta_json, global_rank)
            VALUES (?, ?, ?, ?, ?)
          `).bind(session.id, g.id || g.playerId, name, meta, globalRank++));
        }
      }
    } catch (e) {
      console.error('[draft] rankings seed failed, continuing:', e?.message);
    }

    // D1 batch limit is 100 statements — chunk if needed
    for (let i = 0; i < rankInserts.length; i += 100) {
      await db.batch(rankInserts.slice(i, i + 100));
    }

    await db.prepare(`
      UPDATE draft_sessions SET status = 'active', started_at = ?, total_picks = ?, pick_deadline = ? WHERE id = ?
    `).bind(new Date().toISOString(), totalPicks, pickDeadline, session.id).run();

    // Trigger the DO alarm
    const doId = env.DRAFT_ROOM.idFromName(`league-${leagueId}`);
    const stub = env.DRAFT_ROOM.get(doId);
    await stub.fetch(new Request('https://internal/alarm-reset', {
      method: 'POST',
      headers: { 'X-League-Id': String(leagueId) },
    })).catch(e => console.error('[draft] DO alarm trigger failed:', e?.message));

    return json({ ok: true, totalPicks, pickDeadline });
  }

  const draftWsMatch = pathname.match(/^\/api\/leagues\/(\d+)\/draft\/ws$/);
  if (draftWsMatch && request.method === 'GET') {
    const leagueId = parseId(draftWsMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;

    const myTeam = await db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id = ?').bind(leagueId, ctx.user.id).first();
    const isComm = isCommissioner(ctx.league, ctx.role, ctx.user.id);

    const doId = env.DRAFT_ROOM.idFromName(`league-${leagueId}`);
    const stub = env.DRAFT_ROOM.get(doId);

    const proxiedReq = new Request(request.url, {
      method: request.method,
      headers: new Headers({
        ...Object.fromEntries(request.headers),
        'X-League-Id': String(leagueId),
        'X-User-Id': String(ctx.user.id),
        'X-Team-Id': String(myTeam?.id || ''),
        'X-Is-Commissioner': String(isComm),
      }),
    });

    return stub.fetch(proxiedReq);
  }

  const draftPauseMatch = pathname.match(/^\/api\/leagues\/(\d+)\/draft\/session\/pause$/);
  if (draftPauseMatch && request.method === 'POST') {
    const leagueId = parseId(draftPauseMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id)) return json({ error: 'Commissioner only' }, { status: 403 });

    await db.prepare("UPDATE draft_sessions SET status = 'paused' WHERE league_id = ?").bind(leagueId).run();

    const doId = env.DRAFT_ROOM.idFromName(`league-${leagueId}`);
    const stub = env.DRAFT_ROOM.get(doId);
    await stub.fetch(new Request('https://internal/pause', {
      method: 'POST',
      headers: { 'X-League-Id': String(leagueId) },
    })).catch(console.error);

    return json({ ok: true });
  }

  const draftResumeMatch = pathname.match(/^\/api\/leagues\/(\d+)\/draft\/session\/resume$/);
  if (draftResumeMatch && request.method === 'POST') {
    const leagueId = parseId(draftResumeMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id)) return json({ error: 'Commissioner only' }, { status: 403 });

    const config = mergeConfig(ctx.league.config_json);
    const pickDeadline = new Date(Date.now() + config.pick_timer_seconds * 1000).toISOString();
    await db.prepare("UPDATE draft_sessions SET status = 'active', pick_deadline = ? WHERE league_id = ?").bind(pickDeadline, leagueId).run();

    const doId = env.DRAFT_ROOM.idFromName(`league-${leagueId}`);
    const stub = env.DRAFT_ROOM.get(doId);
    await stub.fetch(new Request('https://internal/alarm-reset', {
      method: 'POST',
      headers: { 'X-League-Id': String(leagueId) },
    })).catch(console.error);

    return json({ ok: true, pickDeadline });
  }
```

- [ ] **Step 2: Add stalled-draft cron recovery**

In `worker/index.js`, in the `scheduled` handler's per-league loop (after the `executeTrades` try/catch block), add:

```js
        try {
          const stalledDraft = await db.prepare(`
            SELECT id FROM draft_sessions
            WHERE status = 'active' AND league_id = ?
              AND pick_deadline < datetime('now', '-2 minutes')
          `).bind(league.id).first();
          if (stalledDraft) {
            const doId = env.DRAFT_ROOM.idFromName(`league-${league.id}`);
            const stub = env.DRAFT_ROOM.get(doId);
            await stub.fetch(new Request('https://internal/alarm-reset', {
              method: 'POST',
              headers: { 'X-League-Id': String(league.id) },
            }));
          }
        } catch (err) {
          console.error(`[cron] league ${league.id} stalled draft recovery failed:`, err?.message ?? err);
        }
```

- [ ] **Step 3: Syntax check**

```bash
node --check worker/index.js
```
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add worker/index.js
git commit -m "feat: draft REST routes — session CRUD, order, start, WS proxy, pause/resume, cron recovery"
```

---

### Task 4: API client + routes + nav

**Files:**
- Modify: `client/src/api.js`
- Modify: `client/src/App.jsx`
- Modify: `client/src/components/LeagueLayout.jsx`

**Interfaces:**
- Consumes: routes from Task 3
- Produces: `api.leagues.draft.*`, `<Route path="draft">`, "Draft" nav link

- [ ] **Step 1: Add draft methods to api.js**

In `client/src/api.js`, inside the `leagues` object, add after `trades: { ... }`:

```js
    draft: {
      getSession: (id) => request(`/api/leagues/${id}/draft/session`),
      create:     (id) => request(`/api/leagues/${id}/draft/session`, { method: 'POST' }),
      setOrder:   (id, order) => request(`/api/leagues/${id}/draft/session/order`, {
        method: 'PUT', body: JSON.stringify({ order }),
      }),
      randomize:  (id) => request(`/api/leagues/${id}/draft/session/randomize`, { method: 'POST' }),
      start:      (id) => request(`/api/leagues/${id}/draft/session/start`, { method: 'POST' }),
      pause:      (id) => request(`/api/leagues/${id}/draft/session/pause`, { method: 'POST' }),
      resume:     (id) => request(`/api/leagues/${id}/draft/session/resume`, { method: 'POST' }),
      connect:    (id) => {
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        return new WebSocket(`${proto}://${window.location.host}/api/leagues/${id}/draft/ws`);
      },
    },
```

- [ ] **Step 2: Add draft route to App.jsx**

In `client/src/App.jsx`, import `DraftPage`:

```js
import DraftPage from './pages/DraftPage';
```

Add the route inside the LeagueLayout routes, after the `trades` route:

```jsx
<Route path="draft" element={<DraftPage />} />
```

- [ ] **Step 3: Add Draft nav link to LeagueLayout.jsx**

In `client/src/components/LeagueLayout.jsx`, add "Draft" to the nav list. Place it between "Trades" and "Rules":

```jsx
<NavLink to="draft">Draft</NavLink>
```

- [ ] **Step 4: Create placeholder DraftPage so the route doesn't crash**

Create `client/src/pages/DraftPage.jsx` with just enough to render without error:

```jsx
import { useParams } from 'react-router-dom';

export default function DraftPage() {
  const { leagueId } = useParams();
  return <div className="page-content"><p>Draft — league {leagueId} — coming soon</p></div>;
}
```

- [ ] **Step 5: Commit**

```bash
git add client/src/api.js client/src/App.jsx client/src/components/LeagueLayout.jsx client/src/pages/DraftPage.jsx
git commit -m "feat: draft API client methods, route, and nav link"
```

---

### Task 5: useDraftSocket hook

**Files:**
- Create: `client/src/hooks/useDraftSocket.js`

**Interfaces:**
- Consumes: `api.leagues.draft.connect(leagueId)` from Task 4
- Produces: `useDraftSocket(leagueId)` → `{ state, send, connected, error }`
  - `state`: the latest `data` payload from a `{ type: 'state', data: {...} }` WS message, or `null`
  - `send(msg)`: sends a JSON-serialized message over the WS; no-ops if not connected
  - `connected`: boolean
  - `error`: string or null

- [ ] **Step 1: Create useDraftSocket.js**

```js
import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api';

export function useDraftSocket(leagueId) {
  const [state, setState] = useState(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const wsRef = useRef(null);
  const retriesRef = useRef(0);
  const MAX_RETRIES = 5;

  const connect = useCallback(() => {
    if (!leagueId) return;

    const ws = api.leagues.draft.connect(leagueId);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setError(null);
      retriesRef.current = 0;
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'state') setState(msg.data);
        if (msg.type === 'error') setError(msg.message);
      } catch {}
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      if (retriesRef.current < MAX_RETRIES) {
        const delay = Math.min(100 * Math.pow(2, retriesRef.current), 10000);
        retriesRef.current += 1;
        setTimeout(connect, delay);
      } else {
        setError('Connection lost. Please refresh the page.');
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [leagueId]);

  useEffect(() => {
    connect();
    return () => {
      retriesRef.current = MAX_RETRIES; // stop reconnects on unmount
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { state, send, connected, error };
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/hooks/useDraftSocket.js
git commit -m "feat: useDraftSocket hook with exponential backoff reconnect"
```

---

### Task 6: DraftPage — PreDraftLobby

**Files:**
- Modify: `client/src/pages/DraftPage.jsx` (replace placeholder)

**Interfaces:**
- Consumes: `api.leagues.draft.*` (Task 4), `useDraftSocket` (Task 5), `useParams`, `useOutletContext`, `useAuth`
- Produces: `DraftPage` with full page shell; `PreDraftLobby` component (shown when `session.status === 'pending'` or no session)

- [ ] **Step 1: Replace DraftPage.jsx with full implementation**

```jsx
import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useOutletContext } from 'react-router-dom';
import { api } from '../api';
import { useDraftSocket } from '../hooks/useDraftSocket';

function PreDraftLobby({ leagueId, initialSession, isCommissioner, onStart }) {
  const [session, setSession] = useState(initialSession);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);

  const draftOrder = session?.draft_order || [];
  const allSlotsFilled = draftOrder.length > 0 && draftOrder.every(t => t.teamId);

  async function createSession() {
    setLoading(true);
    try {
      await api.leagues.draft.create(leagueId);
      const { session: s } = await api.leagues.draft.getSession(leagueId);
      setSession(s);
      setMsg('Draft session created.');
    } catch (e) { setMsg(e.message); }
    setLoading(false);
  }

  async function randomize() {
    setLoading(true);
    try {
      await api.leagues.draft.randomize(leagueId);
      const { session: s } = await api.leagues.draft.getSession(leagueId);
      setSession(s);
      setMsg('Order randomized.');
    } catch (e) { setMsg(e.message); }
    setLoading(false);
  }

  async function startDraft() {
    setLoading(true);
    try {
      await api.leagues.draft.start(leagueId);
      onStart();
    } catch (e) { setMsg(e.message); }
    setLoading(false);
  }

  if (!session) {
    return (
      <div className="draft-lobby">
        <h2>Draft Room</h2>
        <p className="st-dim">No draft session exists yet.</p>
        {isCommissioner && (
          <button onClick={createSession} disabled={loading}>Create Draft Session</button>
        )}
        {msg && <p className="alert">{msg}</p>}
      </div>
    );
  }

  return (
    <div className="draft-lobby">
      <h2>Draft Room — Waiting to Start</h2>
      {msg && <p className="alert">{msg}</p>}

      <div className="draft-order-list" style={{ marginBottom: '1rem' }}>
        <h3>Draft Order</h3>
        {draftOrder.length === 0 ? (
          <p className="st-dim">No order set yet.</p>
        ) : (
          <ol>
            {draftOrder.map((t, i) => (
              <li key={t.teamId}>{i + 1}. {t.teamName}</li>
            ))}
          </ol>
        )}
      </div>

      {isCommissioner ? (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button onClick={randomize} disabled={loading}>Randomize Order</button>
          <button
            onClick={startDraft}
            disabled={loading || !allSlotsFilled}
            title={allSlotsFilled ? '' : 'Set draft order first'}
          >
            Start Draft
          </button>
        </div>
      ) : (
        <p className="st-dim">Waiting for the commissioner to start the draft…</p>
      )}
    </div>
  );
}

export default function DraftPage() {
  const { leagueId } = useParams();
  const { user } = useOutletContext();
  const [initialData, setInitialData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isCommissioner, setIsCommissioner] = useState(false);
  const { state: wsState, send, connected, error: wsError } = useDraftSocket(leagueId);

  useEffect(() => {
    async function load() {
      try {
        const [sessionData, teamsData] = await Promise.all([
          api.leagues.draft.getSession(leagueId),
          api.leagues.getTeams(leagueId),
        ]);
        setInitialData(sessionData);
        // Check commissioner status via teams list (user_id match against league ownership)
        // Actually check via the league object — use getSession ctx or leagueInfo
        // Simple approach: check if the user owns the league
        const leagueInfo = await api.leagues.get(leagueId);
        setIsCommissioner(leagueInfo?.owner_user_id === user?.id || leagueInfo?.my_role === 'commissioner');
      } catch {}
      setLoading(false);
    }
    load();
  }, [leagueId, user]);

  if (loading) return <div className="page-content"><p>Loading draft…</p></div>;

  // Use WS state if connected, otherwise fall back to initialData
  const draftStatus = wsState?.status || initialData?.session?.status || null;

  if (!draftStatus || draftStatus === 'pending') {
    return (
      <div className="page-content">
        <PreDraftLobby
          leagueId={leagueId}
          initialSession={initialData?.session}
          isCommissioner={isCommissioner}
          onStart={() => window.location.reload()}
        />
      </div>
    );
  }

  // Active / paused / completed — rendered in Task 7
  return (
    <div className="page-content">
      <p>Draft status: {draftStatus}</p>
      {wsError && <p className="alert">{wsError}</p>}
      {!connected && <p className="st-dim">Reconnecting…</p>}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/pages/DraftPage.jsx
git commit -m "feat: DraftPage shell with PreDraftLobby — create session, randomize order, start draft"
```

---

### Task 7: DraftPage — active draft room

**Files:**
- Modify: `client/src/pages/DraftPage.jsx` — replace the `// Active / paused / completed` stub with full room UI

**Interfaces:**
- Consumes: `wsState` from `useDraftSocket` — shape:
  ```js
  {
    status,           // 'active' | 'paused' | 'completed'
    currentPick,      // number (0-based overall)
    totalPicks,       // number
    currentTeamId,    // number | null
    pickDeadline,     // ISO8601 string | null
    draftOrder,       // [{teamId, teamName}]
    picks,            // [{teamId,teamName,playerId,playerName,position,nhlTeam,headshotUrl,round,pickInRound,overallPick,isAutoPick,pickedAt}]
    myQueue,          // [{playerId,playerName,position,nhlTeam,headshotUrl,crestUrl}]
    available,        // top-50 undrafted [{playerId,playerName,position,nhlTeam,headshotUrl}]
  }
  ```
- Consumes: `send(msg)` from `useDraftSocket`

- [ ] **Step 1: Add sub-components above the DraftPage export**

Add these components to `client/src/pages/DraftPage.jsx` after the `PreDraftLobby` function, before the `export default`:

```jsx
function DraftTimerBar({ pickDeadline, status, teamName }) {
  const [secs, setSecs] = useState(null);

  useEffect(() => {
    if (!pickDeadline || status !== 'active') { setSecs(null); return; }
    const tick = () => {
      const remaining = Math.max(0, Math.floor((new Date(pickDeadline) - Date.now()) / 1000));
      setSecs(remaining);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [pickDeadline, status]);

  if (status === 'completed') return null;
  if (status === 'paused') return (
    <div className="draft-timer" style={{ background: '#555', color: '#fff', padding: '0.5rem 1rem', borderRadius: 4 }}>
      ⏸ PAUSED
    </div>
  );

  const color = secs === null ? '#888' : secs <= 10 ? '#c0392b' : secs <= 20 ? '#e67e22' : '#27ae60';
  return (
    <div className="draft-timer" style={{ background: color, color: '#fff', padding: '0.5rem 1rem', borderRadius: 4 }}>
      {teamName ? `${teamName} is on the clock` : 'Waiting…'}
      {secs !== null && ` — ${secs}s`}
    </div>
  );
}

function DraftBoardGrid({ draftOrder, picks, currentPick, totalPicks, currentTeamId }) {
  const numTeams = draftOrder.length;
  if (numTeams === 0) return null;
  const numRounds = totalPicks > 0 ? Math.ceil(totalPicks / numTeams) : 0;

  // Build pick lookup: key = `${round}-${teamId}` -> pick object
  const pickMap = {};
  for (const p of picks) pickMap[`${p.round}-${p.teamId}`] = p;

  // For a snake draft: which teamId is at (round, slotInRound)?
  function teamAtSlot(round, slotInRound) {
    const idx = (round % 2 === 1) ? slotInRound : (numTeams - 1 - slotInRound);
    return draftOrder[idx]?.teamId;
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: '0.8rem', minWidth: '100%' }}>
        <thead>
          <tr>
            <th style={{ padding: '4px 8px', borderBottom: '1px solid #444' }}>Rd</th>
            {draftOrder.map(t => (
              <th key={t.teamId} style={{ padding: '4px 8px', borderBottom: '1px solid #444', whiteSpace: 'nowrap' }}>
                {t.teamName}
                {t.teamId === currentTeamId && <span style={{ color: '#f1c40f', marginLeft: 4 }}>▶</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: numRounds }, (_, ri) => {
            const round = ri + 1;
            return (
              <tr key={round}>
                <td style={{ padding: '4px 8px', color: '#888', fontWeight: 'bold' }}>{round}</td>
                {draftOrder.map((t, si) => {
                  const tid = teamAtSlot(round, si);
                  const pick = pickMap[`${round}-${tid}`];
                  const isCurrentSlot = !pick && (ri * numTeams + si) === currentPick;
                  return (
                    <td key={t.teamId} style={{
                      padding: '4px 6px', border: '1px solid #333', maxWidth: 100,
                      background: isCurrentSlot ? '#2c3e50' : 'transparent',
                      outline: isCurrentSlot ? '2px solid #f1c40f' : 'none',
                    }}>
                      {pick ? (
                        <span title={pick.playerName}>
                          {pick.position && <span style={{ color: '#888', fontSize: '0.7rem', marginRight: 2 }}>{pick.position}</span>}
                          {pick.playerName}
                          {pick.isAutoPick && <span style={{ color: '#e67e22', fontSize: '0.7rem' }}> ✦</span>}
                        </span>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DraftAvailablePlayers({ available, myQueue, currentTeamId, myTeamId, status, send }) {
  const [tab, setTab] = useState('ALL');
  const [search, setSearch] = useState('');
  const queuedIds = new Set((myQueue || []).map(p => p.playerId));
  const isMyTurn = myTeamId && myTeamId === currentTeamId && status === 'active';

  const filtered = (available || []).filter(p => {
    if (tab !== 'ALL' && p.position !== tab) return false;
    if (search && !p.playerName.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="draft-available">
      <h3 style={{ marginTop: 0 }}>Available Players</h3>
      <input
        placeholder="Search…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ width: '100%', marginBottom: '0.5rem', boxSizing: 'border-box' }}
      />
      <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '0.5rem' }}>
        {['ALL', 'F', 'D', 'G'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{ fontWeight: tab === t ? 'bold' : 'normal' }}>
            {t}
          </button>
        ))}
      </div>
      <div style={{ maxHeight: 400, overflowY: 'auto' }}>
        {filtered.slice(0, 100).map(p => (
          <div key={p.playerId} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '4px 0', borderBottom: '1px solid #333' }}>
            {p.headshotUrl && <img src={p.headshotUrl} alt="" style={{ width: 28, height: 28, borderRadius: '50%' }} />}
            <span style={{ flex: 1 }}>
              <span style={{ color: '#888', fontSize: '0.75rem', marginRight: 4 }}>{p.position}</span>
              {p.playerName}
              <span style={{ color: '#888', fontSize: '0.75rem', marginLeft: 4 }}>{p.nhlTeam}</span>
            </span>
            <button
              disabled={queuedIds.has(p.playerId)}
              onClick={() => send({ type: 'queue_add', playerId: p.playerId, playerName: p.playerName, playerMeta: { position: p.position, nhlTeam: p.nhlTeam, headshotUrl: p.headshotUrl, crestUrl: p.crestUrl || '' } })}
              style={{ fontSize: '0.75rem', padding: '2px 6px' }}
            >
              {queuedIds.has(p.playerId) ? '✓' : '+ Queue'}
            </button>
            {isMyTurn && (
              <button
                onClick={() => send({ type: 'pick', playerId: p.playerId, playerName: p.playerName, playerMeta: { position: p.position, nhlTeam: p.nhlTeam, headshotUrl: p.headshotUrl, crestUrl: p.crestUrl || '' } })}
                style={{ fontSize: '0.75rem', padding: '2px 6px', background: '#27ae60', color: '#fff', border: 'none', cursor: 'pointer' }}
              >
                Draft
              </button>
            )}
          </div>
        ))}
        {filtered.length === 0 && <p className="st-dim">No players match.</p>}
      </div>
    </div>
  );
}

function DraftQueuePanel({ myQueue, send }) {
  const [dragging, setDragging] = useState(null);

  function onDragStart(e, idx) {
    setDragging(idx);
    e.dataTransfer.effectAllowed = 'move';
  }

  function onDrop(e, targetIdx) {
    e.preventDefault();
    if (dragging === null || dragging === targetIdx) return;
    const reordered = [...myQueue];
    const [item] = reordered.splice(dragging, 1);
    reordered.splice(targetIdx, 0, item);
    send({ type: 'queue_reorder', playerIds: reordered.map(p => p.playerId) });
    setDragging(null);
  }

  return (
    <div className="draft-queue">
      <h3 style={{ marginTop: 0 }}>My Queue</h3>
      {(!myQueue || myQueue.length === 0) && <p className="st-dim">Add players to your queue.</p>}
      {(myQueue || []).map((p, i) => (
        <div
          key={p.playerId}
          draggable
          onDragStart={e => onDragStart(e, i)}
          onDragOver={e => e.preventDefault()}
          onDrop={e => onDrop(e, i)}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '4px 0', borderBottom: '1px solid #333', cursor: 'grab' }}
        >
          <span style={{ color: '#555', fontSize: '0.75rem', width: 16, textAlign: 'right' }}>{i + 1}</span>
          <span style={{ flex: 1, fontSize: '0.85rem' }}>
            <span style={{ color: '#888', fontSize: '0.7rem', marginRight: 4 }}>{p.position}</span>
            {p.playerName}
          </span>
          <button
            onClick={() => send({ type: 'queue_remove', playerId: p.playerId })}
            style={{ fontSize: '0.7rem', padding: '1px 5px', background: 'transparent', border: '1px solid #555', cursor: 'pointer' }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Replace the active-room stub in DraftPage**

In the `DraftPage` component, replace:

```jsx
  // Active / paused / completed — rendered in Task 7
  return (
    <div className="page-content">
      <p>Draft status: {draftStatus}</p>
      {wsError && <p className="alert">{wsError}</p>}
      {!connected && <p className="st-dim">Reconnecting…</p>}
    </div>
  );
```

with:

```jsx
  // Use combined initialData + wsState (ws overrides once connected)
  const liveState = wsState || {
    status: initialData?.session?.status,
    currentPick: initialData?.session?.current_pick || 0,
    totalPicks: initialData?.session?.total_picks || 0,
    currentTeamId: null,
    pickDeadline: initialData?.session?.pick_deadline || null,
    draftOrder: initialData?.session?.draft_order || [],
    picks: (initialData?.picks || []).map(p => ({
      ...p, ...p.player_meta,
      teamId: p.team_id, teamName: p.team_name,
      playerId: p.player_id, playerName: p.player_name,
      overallPick: p.overall_pick, pickInRound: p.pick_in_round,
      isAutoPick: !!p.is_auto_pick, pickedAt: p.picked_at,
    })),
    myQueue: (initialData?.myQueue || []).map(q => ({
      ...q.player_meta,
      playerId: q.player_id, playerName: q.player_name,
    })),
    available: [],
  };

  const myTeamId = /* derive from user */ null; // assigned below
  // We need myTeamId — load it from initialData teams
  const [myTeamId2, setMyTeamId2] = useState(null);
  useEffect(() => {
    api.leagues.getTeams(leagueId).then(teams => {
      const mine = (teams || []).find(t => t.user_id === user?.id);
      if (mine) setMyTeamId2(mine.id);
    }).catch(() => {});
  }, [leagueId, user]);

  const onClockTeam = liveState.draftOrder.find(t => t.teamId === liveState.currentTeamId);

  return (
    <div className="page-content">
      {wsError && <p className="alert">{wsError}</p>}
      {!connected && liveState.status === 'active' && <p className="st-dim">Reconnecting…</p>}

      <DraftTimerBar
        pickDeadline={liveState.pickDeadline}
        status={liveState.status}
        teamName={onClockTeam?.teamName}
      />

      {liveState.status === 'completed' && (
        <p style={{ color: '#27ae60', fontWeight: 'bold', margin: '0.5rem 0' }}>Draft Complete!</p>
      )}

      {isCommissioner && liveState.status === 'active' && (
        <button onClick={() => api.leagues.draft.pause(leagueId)} style={{ marginTop: '0.5rem' }}>Pause Draft</button>
      )}
      {isCommissioner && liveState.status === 'paused' && (
        <button onClick={() => api.leagues.draft.resume(leagueId)} style={{ marginTop: '0.5rem' }}>Resume Draft</button>
      )}

      <div style={{ marginTop: '1rem' }}>
        <DraftBoardGrid
          draftOrder={liveState.draftOrder}
          picks={liveState.picks}
          currentPick={liveState.currentPick}
          totalPicks={liveState.totalPicks}
          currentTeamId={liveState.currentTeamId}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1rem' }}>
        <DraftAvailablePlayers
          available={liveState.available}
          myQueue={liveState.myQueue}
          currentTeamId={liveState.currentTeamId}
          myTeamId={myTeamId2}
          status={liveState.status}
          send={send}
        />
        <DraftQueuePanel
          myQueue={liveState.myQueue}
          send={send}
        />
      </div>
    </div>
  );
```

Also add `useState` to the imports at the top of `DraftPage.jsx` (it should already be there from Task 6; verify it is).

- [ ] **Step 3: Syntax check**

```bash
node --check worker/index.js && node --check worker/draft-room.js
```
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/DraftPage.jsx
git commit -m "feat: DraftPage active room — board grid, timer bar, available players, drag-to-reorder queue"
```

---

### Task 8: CommissionerDashboard — Draft Setup section

**Files:**
- Modify: `client/src/pages/CommissionerDashboard.jsx`

**Interfaces:**
- Consumes: `api.leagues.draft.create`, `api.leagues.update` (for pick timer config)
- Produces: "Draft Setup" section with create button, pick timer input, and link to draft page

- [ ] **Step 1: Add draft setup state and handlers**

In `CommissionerDashboard.jsx`, add to the existing state declarations (after whichever state vars exist):

```js
const [draftSession, setDraftSession] = useState(null);
const [draftMsg, setDraftMsg] = useState('');
const [pickTimer, setPickTimer] = useState(90);
```

In the existing `useEffect` that loads league data, also load the draft session:

```js
api.leagues.draft.getSession(leagueId).then(d => setDraftSession(d.session)).catch(() => {});
```

Add the handler:

```js
async function createDraftSession() {
  try {
    await api.leagues.draft.create(leagueId);
    setDraftMsg('Draft session created. Go to the Draft page to set order and start.');
    const d = await api.leagues.draft.getSession(leagueId);
    setDraftSession(d.session);
  } catch (e) { setDraftMsg(e.message); }
}

async function savePickTimer() {
  try {
    await api.leagues.update(leagueId, { pick_timer_seconds: Number(pickTimer) });
    setDraftMsg('Pick timer saved.');
  } catch (e) { setDraftMsg(e.message); }
}
```

- [ ] **Step 2: Add Draft Setup JSX section**

In `CommissionerDashboard.jsx`, add a new section after the "Waiver Priorities" section (which was the last section added in Phase 2):

```jsx
<div style={{ marginTop: '2rem', borderTop: '1px solid #333', paddingTop: '1rem' }}>
  <h3>Draft Setup</h3>
  {draftMsg && <p className="alert">{draftMsg}</p>}

  <div style={{ marginBottom: '1rem' }}>
    <label>Pick Timer (seconds)
      <input
        type="number"
        min={15}
        max={300}
        value={pickTimer}
        onChange={e => setPickTimer(e.target.value)}
        style={{ marginLeft: '0.5rem', width: 70 }}
      />
    </label>
    <button onClick={savePickTimer} style={{ marginLeft: '0.5rem' }}>Save Timer</button>
  </div>

  {!draftSession ? (
    <button onClick={createDraftSession}>Create Draft Session</button>
  ) : (
    <p className="st-dim">
      Draft session exists (status: <strong>{draftSession.status}</strong>).{' '}
      <a href={`/leagues/${leagueId}/draft`}>Go to Draft Room →</a>
    </p>
  )}
</div>
```

- [ ] **Step 3: Initialize pickTimer from league config on load**

In the existing `useEffect` that fetches league data (wherever `config_json` is loaded), add:

```js
if (leagueData?.config_json) {
  const cfg = JSON.parse(leagueData.config_json);
  if (cfg.pick_timer_seconds) setPickTimer(cfg.pick_timer_seconds);
}
```

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/CommissionerDashboard.jsx
git commit -m "feat: CommissionerDashboard draft setup — create session, pick timer config"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| Migration 0013 (4 tables) | Task 1 |
| DO binding + wrangler.toml migration | Task 1 |
| `pick_timer_seconds: 90` in config | Task 1 |
| `DraftRoom` class — WS lifecycle, state, rehydration | Task 2 |
| Pick processing, timer/alarm, auto-pick by position need | Task 2 |
| Queue add/remove/reorder + D1 persist | Task 2 |
| Pause/resume (WS + internal /pause + /alarm-reset) | Task 2 + 3 |
| All REST routes | Task 3 |
| NHL stats ranking seed on start | Task 3 |
| Stalled-draft cron recovery | Task 3 |
| `api.leagues.draft.*` client methods | Task 4 |
| Route + nav link | Task 4 |
| `useDraftSocket` hook with backoff | Task 5 |
| PreDraftLobby — create, randomize, start | Task 6 |
| Board grid, timer bar, available players, queue panel | Task 7 |
| CommissionerDashboard draft section | Task 8 |

**Placeholder scan:** None found.

**Type consistency:**
- `snapshot()` → `{ status, currentPick, totalPicks, currentTeamId, pickDeadline, draftOrder: [{teamId,teamName}], picks, myQueue, available }` — all consumers in Task 7 reference these exact keys ✓
- `send({ type: 'pick', playerId, playerName, playerMeta })` — `handlePick` reads `msg.playerId`, `msg.playerName`, `msg.playerMeta` ✓
- `send({ type: 'queue_add', playerId, playerName, playerMeta })` — `handleQueueAdd` reads same ✓
- `persistQueue(teamId)` called in `handleQueueRemove` and `handleQueueReorder` ✓
- `executePick` called with `{ playerId, playerName, playerMeta }` from both `handlePick` and `autoPickForCurrentTeam` ✓
