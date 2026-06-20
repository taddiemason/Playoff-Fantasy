# Auction Draft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real-time auction draft where teams take turns nominating players, everyone bids simultaneously on a 30-second countdown timer (resets per bid), and the highest bidder wins the player — each team has a $1,000 budget.

**Architecture:** A new `AuctionRoom` Durable Object (`worker/auction-room.js`) drives the nomination cycle using the DO Alarm API as the bid countdown. Worker REST routes handle session lifecycle. The frontend connects via WebSocket proxied through the Worker, using the same `X-League-Id / X-User-Id / X-Team-Id / X-Is-Commissioner` header pattern as the existing snake draft.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Durable Objects + Alarm API, WebSocketPair, React 18, React Router v6

## Global Constraints

- `auction_budget` default: **1000** (integer, dollars per team)
- `bid_timer_seconds` default: **30** (integer, seconds — resets on each new bid)
- Minimum bid: **$1**
- Bid floor formula: `maxBid = budgetRemaining - remainingRosterSlots + 1`
- `remainingRosterSlots = (capsF + capsD + capsG) - (F + D + G)` for that team
- Position for cap checks comes from server-side `globalRankings`, not client `playerMeta`
- DO binding name: `AUCTION_ROOM`, keyed `league-{leagueId}`
- `position_detail = ''` on all `team_players` inserts
- `team_players` columns: `(team_id, player_id, player_name, nhl_team, position, position_detail, headshot_url, crest_url)` — no league_id column
- Rankings seeded in chunks of ≤100 D1 statements (same NHL API as snake draft)
- All WS sends in silent try/catch
- Stalled-auction threshold: `bidDeadline` older than 2 minutes
- Auction routes inserted before `// ── Waivers` comment in `worker/index.js`
- Re-export in `worker/index.js`: `export { AuctionRoom } from './auction-room.js';`

---

### Task 1: Migration + wrangler.toml DO binding + config defaults

**Files:**
- Create: `migrations/0014_auction.sql`
- Modify: `wrangler.toml`
- Modify: `worker/index.js` (lines 236 and 265 area — DEFAULT_LEAGUE_CONFIG + mergeConfig)

**Interfaces:**
- Produces: 4 new D1 tables (`auction_sessions`, `auction_picks`, `auction_budgets`, `auction_player_rankings`); `AUCTION_ROOM` binding; `config.auction_budget` and `config.bid_timer_seconds` accessible via `mergeConfig()`

- [ ] **Step 1: Create migration file**

Create `migrations/0014_auction.sql` with this exact content:

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
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_session_id    INTEGER NOT NULL REFERENCES auction_sessions(id) ON DELETE CASCADE,
  player_id             INTEGER NOT NULL,
  player_name           TEXT NOT NULL,
  player_meta_json      TEXT NOT NULL DEFAULT '{}',
  team_id               INTEGER NOT NULL,
  amount                INTEGER NOT NULL,
  nominated_by_team_id  INTEGER NOT NULL,
  pick_number           INTEGER NOT NULL,
  picked_at             TEXT NOT NULL,
  UNIQUE(auction_session_id, player_id)
);

CREATE TABLE auction_budgets (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_session_id    INTEGER NOT NULL REFERENCES auction_sessions(id) ON DELETE CASCADE,
  team_id               INTEGER NOT NULL,
  budget_remaining      INTEGER NOT NULL,
  UNIQUE(auction_session_id, team_id)
);

CREATE TABLE auction_player_rankings (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_session_id    INTEGER NOT NULL REFERENCES auction_sessions(id) ON DELETE CASCADE,
  player_id             INTEGER NOT NULL,
  player_name           TEXT NOT NULL,
  player_meta_json      TEXT NOT NULL DEFAULT '{}',
  global_rank           INTEGER NOT NULL,
  UNIQUE(auction_session_id, player_id)
);
```

- [ ] **Step 2: Add AUCTION_ROOM binding to wrangler.toml**

Add after the existing `[[durable_objects.bindings]]` block and `[[migrations]]` block:

```toml
[[durable_objects.bindings]]
name = "AUCTION_ROOM"
class_name = "AuctionRoom"

[[migrations]]
tag = "v2"
new_classes = ["AuctionRoom"]
```

Final `wrangler.toml` should have two `[[durable_objects.bindings]]` entries (DraftRoom + AuctionRoom) and two `[[migrations]]` entries (v1 + v2).

- [ ] **Step 3: Add config defaults to worker/index.js**

In `DEFAULT_LEAGUE_CONFIG` (around line 236), add after `pick_timer_seconds: 90,`:

```js
  auction_budget: 1000,
  bid_timer_seconds: 30,
```

In `mergeConfig` (around line 265), add after `pick_timer_seconds: parsed.pick_timer_seconds ?? d.pick_timer_seconds,`:

```js
    auction_budget: parsed.auction_budget ?? d.auction_budget,
    bid_timer_seconds: parsed.bid_timer_seconds ?? d.bid_timer_seconds,
```

- [ ] **Step 4: Verify syntax**

```
node --check worker/index.js
```

Expected: no output (exit 0).

- [ ] **Step 5: Commit**

```
git add migrations/0014_auction.sql wrangler.toml worker/index.js
git commit -m "feat: migration 0014 auction tables, AUCTION_ROOM DO binding, budget/timer config defaults"
```

---

### Task 2: AuctionRoom Durable Object

**Files:**
- Create: `worker/auction-room.js`
- Modify: `worker/index.js` (add re-export at top, after the DraftRoom re-export line)

**Interfaces:**
- Consumes: `migrations/0014_auction.sql` tables; `env.DB`; `env.AUCTION_ROOM` (self); `this.state.storage.setAlarm / deleteAlarm`
- Produces: `AuctionRoom` class exported from `worker/auction-room.js`; re-exported from `worker/index.js` as `export { AuctionRoom } from './auction-room.js';`

- [ ] **Step 1: Create worker/auction-room.js**

Create `worker/auction-room.js` with the following complete implementation:

```js
export class AuctionRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.initialized = false;
    this.auctionSessionId = null;
    this.leagueId = null;
    this.status = 'pending';
    this.draftOrder = [];        // [{teamId, teamName}]
    this.nominatorIdx = 0;
    this.totalTeams = 0;
    this.timerSeconds = 30;
    this.budgetPerTeam = 1000;

    this.capsF = 10;
    this.capsD = 5;
    this.capsG = 3;

    this.budgets = new Map();    // teamId -> remaining integer
    this.rosters = new Map();    // teamId -> {F, D, G}
    this.picks = [];             // completed awards
    this.teamNames = new Map();  // teamId -> name
    this.currentNomination = null;
    this.pickedPlayerIds = new Set();
    this.globalRankings = [];    // ordered by global_rank
    this.clients = new Map();    // WebSocket -> {teamId, userId, isCommissioner}
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/pause' && request.method === 'POST') {
      await this.state.storage.deleteAlarm();
      this.status = 'paused';
      this.broadcastAll();
      return new Response('ok');
    }

    if (path === '/alarm-reset' && request.method === 'POST') {
      const leagueId = parseInt(request.headers.get('X-League-Id') || '0');
      if (!this.initialized) await this.rehydrate(leagueId);
      const session = await this.env.DB.prepare(
        'SELECT status, current_nomination_json FROM auction_sessions WHERE id = ?'
      ).bind(this.auctionSessionId).first();
      if (!session) return new Response('ok');
      this.status = session.status;
      if (session.current_nomination_json) {
        this.currentNomination = JSON.parse(session.current_nomination_json);
      }
      if (this.status === 'active' && this.currentNomination) {
        const deadline = new Date(this.currentNomination.bidDeadline).getTime();
        await this.state.storage.setAlarm(deadline > Date.now() ? deadline : Date.now() + 100);
      }
      this.broadcastAll();
      return new Response('ok');
    }

    // WebSocket upgrade
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const leagueId = parseInt(request.headers.get('X-League-Id') || '0');
    const userId   = parseInt(request.headers.get('X-User-Id') || '0');
    const teamId   = parseInt(request.headers.get('X-Team-Id') || '0') || null;
    const isCommissioner = request.headers.get('X-Is-Commissioner') === 'true';

    if (!this.initialized) await this.rehydrate(leagueId);

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();

    const sender = { teamId, userId, isCommissioner };
    this.clients.set(server, sender);

    server.addEventListener('message', async (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        await this.handleMessage(server, sender, msg);
      } catch {
        this.send(server, { type: 'error', message: 'Invalid message' });
      }
    });

    server.addEventListener('close', () => { this.clients.delete(server); });

    this.send(server, { type: 'state', data: this.snapshot(server) });
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm() {
    if (this.status !== 'active') return;
    if (this.currentNomination !== null) {
      await this.awardCurrentNomination();
    } else {
      await this.autoNominate();
    }
  }

  async rehydrate(leagueId) {
    this.leagueId = leagueId;
    const db = this.env.DB;

    const session = await db.prepare(
      'SELECT * FROM auction_sessions WHERE league_id = ?'
    ).bind(leagueId).first();
    if (!session) { this.initialized = true; return; }

    this.auctionSessionId   = session.id;
    this.status             = session.status;
    this.nominatorIdx       = session.current_nominator_idx;
    this.draftOrder         = JSON.parse(session.draft_order_json || '[]');
    this.totalTeams         = this.draftOrder.length;
    this.budgetPerTeam      = session.budget_per_team;
    this.currentNomination  = session.current_nomination_json
      ? JSON.parse(session.current_nomination_json) : null;

    const league = await db.prepare('SELECT config_json FROM leagues WHERE id = ?').bind(leagueId).first();
    const config = JSON.parse(league?.config_json || '{}');
    this.timerSeconds = config.bid_timer_seconds ?? 30;
    this.capsF = config.roster?.maxF ?? 10;
    this.capsD = config.roster?.maxD ?? 5;
    this.capsG = config.roster?.maxG ?? 3;

    // Team names
    if (this.draftOrder.length > 0) {
      const ph = this.draftOrder.map(() => '?').join(',');
      const { results: teams } = await db.prepare(
        `SELECT id, name FROM teams WHERE id IN (${ph})`
      ).bind(...this.draftOrder.map(t => t.teamId)).all();
      for (const t of (teams || [])) this.teamNames.set(t.id, t.name);
    }

    // Budgets
    const { results: budgetRows } = await db.prepare(
      'SELECT team_id, budget_remaining FROM auction_budgets WHERE auction_session_id = ?'
    ).bind(session.id).all();
    for (const b of (budgetRows || [])) this.budgets.set(b.team_id, b.budget_remaining);

    // Picks + rebuild rosters
    const { results: pickRows } = await db.prepare(
      'SELECT * FROM auction_picks WHERE auction_session_id = ? ORDER BY pick_number'
    ).bind(session.id).all();
    for (const p of (pickRows || [])) {
      const meta = JSON.parse(p.player_meta_json || '{}');
      this.pickedPlayerIds.add(p.player_id);
      this.picks.push({ ...p, playerMeta: meta });
      const pos = (meta.position || 'F').toUpperCase();
      const roster = this.rosters.get(p.team_id) || { F: 0, D: 0, G: 0 };
      roster[pos] = (roster[pos] || 0) + 1;
      this.rosters.set(p.team_id, roster);
    }

    // Rankings
    const { results: rankRows } = await db.prepare(
      'SELECT player_id, player_name, player_meta_json FROM auction_player_rankings WHERE auction_session_id = ? ORDER BY global_rank'
    ).bind(session.id).all();
    this.globalRankings = (rankRows || []).map(r => {
      const meta = JSON.parse(r.player_meta_json || '{}');
      return {
        playerId: r.player_id,
        playerName: r.player_name,
        position: meta.position || 'F',
        nhlTeam: meta.nhl_team || '',
        headshotUrl: meta.headshot_url || '',
        crestUrl: meta.crest_url || '',
      };
    });

    this.initialized = true;
  }

  async handleMessage(ws, sender, msg) {
    switch (msg.type) {
      case 'nominate': return this.handleNominate(ws, sender, msg);
      case 'bid':      return this.handleBid(ws, sender, msg);
      case 'pause':    return this.handlePause(ws, sender);
      case 'resume':   return this.handleResume(ws, sender);
      default: this.send(ws, { type: 'error', message: 'Unknown message type' });
    }
  }

  async handleNominate(ws, sender, msg) {
    if (this.status !== 'active')
      return this.send(ws, { type: 'error', message: 'Auction not active' });
    if (this.currentNomination !== null)
      return this.send(ws, { type: 'error', message: 'Nomination already in flight' });

    const currentNominator = this.draftOrder[this.nominatorIdx % this.totalTeams];
    if (!sender.teamId || sender.teamId !== currentNominator?.teamId)
      return this.send(ws, { type: 'error', message: 'Not your turn to nominate' });

    const { playerId, playerName, playerMeta = {}, openingBid = 1 } = msg;
    if (!playerId || !playerName)
      return this.send(ws, { type: 'error', message: 'playerId and playerName required' });
    if (this.pickedPlayerIds.has(playerId))
      return this.send(ws, { type: 'error', message: 'Player already awarded' });
    if (openingBid < 1)
      return this.send(ws, { type: 'error', message: 'Minimum bid is $1' });

    const budget = this.budgets.get(sender.teamId) ?? this.budgetPerTeam;
    const roster = this.rosters.get(sender.teamId) || { F: 0, D: 0, G: 0 };
    const remainingSlots = (this.capsF + this.capsD + this.capsG) - (roster.F + roster.D + roster.G);
    const maxBid = budget - remainingSlots + 1;
    if (openingBid > maxBid)
      return this.send(ws, { type: 'error', message: `Maximum bid is $${maxBid}` });

    // Resolve position from server-side rankings
    const ranked = this.globalRankings.find(r => r.playerId === playerId);
    const pos = ranked?.position || playerMeta.position || 'F';

    await this._startNomination(sender.teamId, playerId, playerName,
      { ...playerMeta, position: pos }, openingBid);
  }

  async _startNomination(nominatorTeamId, playerId, playerName, playerMeta, openingBid) {
    const bidDeadline = new Date(Date.now() + this.timerSeconds * 1000).toISOString();
    this.currentNomination = {
      playerId, playerName, playerMeta,
      nominatedByTeamId: nominatorTeamId,
      currentBid: openingBid,
      currentBidderId: nominatorTeamId,
      bidDeadline,
    };
    await this.env.DB.prepare(
      'UPDATE auction_sessions SET current_nomination_json = ? WHERE id = ?'
    ).bind(JSON.stringify(this.currentNomination), this.auctionSessionId).run();
    await this.state.storage.setAlarm(new Date(bidDeadline).getTime());
    this.broadcastAll();
  }

  async handleBid(ws, sender, msg) {
    if (this.status !== 'active')
      return this.send(ws, { type: 'error', message: 'Auction not active' });
    if (!this.currentNomination)
      return this.send(ws, { type: 'error', message: 'No nomination in flight' });
    if (!sender.teamId)
      return this.send(ws, { type: 'error', message: 'No team associated' });

    const roster = this.rosters.get(sender.teamId) || { F: 0, D: 0, G: 0 };
    const remainingSlots = (this.capsF + this.capsD + this.capsG) - (roster.F + roster.D + roster.G);
    if (remainingSlots === 0)
      return this.send(ws, { type: 'error', message: 'Your roster is full' });

    const pos = (this.currentNomination.playerMeta.position || 'F').toUpperCase();
    const cap = pos === 'G' ? this.capsG : pos === 'D' ? this.capsD : this.capsF;
    if ((roster[pos] || 0) >= cap)
      return this.send(ws, { type: 'error', message: `Your ${pos} roster is full` });

    const { amount } = msg;
    if (typeof amount !== 'number' || amount <= this.currentNomination.currentBid)
      return this.send(ws, { type: 'error', message: `Bid must exceed $${this.currentNomination.currentBid}` });

    const budget = this.budgets.get(sender.teamId) ?? this.budgetPerTeam;
    const maxBid = budget - remainingSlots + 1;
    if (amount > maxBid)
      return this.send(ws, { type: 'error', message: `Maximum bid is $${maxBid}` });

    this.currentNomination.currentBid = amount;
    this.currentNomination.currentBidderId = sender.teamId;
    const newDeadline = new Date(Date.now() + this.timerSeconds * 1000).toISOString();
    this.currentNomination.bidDeadline = newDeadline;

    await this.state.storage.deleteAlarm();
    await this.state.storage.setAlarm(new Date(newDeadline).getTime());
    await this.env.DB.prepare(
      'UPDATE auction_sessions SET current_nomination_json = ? WHERE id = ?'
    ).bind(JSON.stringify(this.currentNomination), this.auctionSessionId).run();
    this.broadcastAll();
  }

  async handlePause(ws, sender) {
    if (!sender.isCommissioner)
      return this.send(ws, { type: 'error', message: 'Commissioner only' });
    await this.state.storage.deleteAlarm();
    this.status = 'paused';
    this.broadcastAll();
  }

  async handleResume(ws, sender) {
    if (!sender.isCommissioner)
      return this.send(ws, { type: 'error', message: 'Commissioner only' });
    if (this.currentNomination) {
      const newDeadline = new Date(Date.now() + this.timerSeconds * 1000).toISOString();
      this.currentNomination.bidDeadline = newDeadline;
      await this.env.DB.prepare(
        'UPDATE auction_sessions SET current_nomination_json = ? WHERE id = ?'
      ).bind(JSON.stringify(this.currentNomination), this.auctionSessionId).run();
      await this.state.storage.setAlarm(new Date(newDeadline).getTime());
    }
    this.status = 'active';
    this.broadcastAll();
  }

  async awardCurrentNomination() {
    const nom = this.currentNomination;
    if (!nom) return;

    const pickNumber = this.picks.length + 1;
    const now = new Date().toISOString();
    const metaJson = JSON.stringify({
      position:    nom.playerMeta.position || 'F',
      nhl_team:    nom.playerMeta.nhlTeam || nom.playerMeta.nhl_team || '',
      headshot_url: nom.playerMeta.headshotUrl || nom.playerMeta.headshot_url || '',
      crest_url:   nom.playerMeta.crestUrl || nom.playerMeta.crest_url || '',
    });

    // Update in-memory state first (needed for nextIdx calculation)
    this.pickedPlayerIds.add(nom.playerId);
    const winnerRoster = this.rosters.get(nom.currentBidderId) || { F: 0, D: 0, G: 0 };
    const pos = (nom.playerMeta.position || 'F').toUpperCase();
    winnerRoster[pos] = (winnerRoster[pos] || 0) + 1;
    this.rosters.set(nom.currentBidderId, winnerRoster);
    const prevBudget = this.budgets.get(nom.currentBidderId) ?? this.budgetPerTeam;
    this.budgets.set(nom.currentBidderId, prevBudget - nom.currentBid);
    this.picks.push({
      pickNumber, pickedAt: now, teamId: nom.currentBidderId,
      amount: nom.currentBid, ...nom,
    });
    this.currentNomination = null;

    const totalSlots = (this.capsF + this.capsD + this.capsG) * this.totalTeams;
    const isLast = pickNumber >= totalSlots;

    // Find next nominator (skip full teams)
    let nextIdx = (this.nominatorIdx + 1) % this.totalTeams;
    if (!isLast) {
      const totalRosterSlots = this.capsF + this.capsD + this.capsG;
      let skips = 0;
      while (skips < this.totalTeams) {
        const t = this.draftOrder[nextIdx % this.totalTeams];
        const r = this.rosters.get(t.teamId) || { F: 0, D: 0, G: 0 };
        if (r.F + r.D + r.G < totalRosterSlots) break;
        nextIdx = (nextIdx + 1) % this.totalTeams;
        skips++;
      }
    }
    this.nominatorIdx = nextIdx;

    // D1 batch
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO auction_picks
           (auction_session_id, player_id, player_name, player_meta_json, team_id, amount, nominated_by_team_id, pick_number, picked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(this.auctionSessionId, nom.playerId, nom.playerName, metaJson,
             nom.currentBidderId, nom.currentBid, nom.nominatedByTeamId, pickNumber, now),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO team_players
           (team_id, player_id, player_name, nhl_team, position, position_detail, headshot_url, crest_url)
         VALUES (?, ?, ?, ?, ?, '', ?, ?)`
      ).bind(nom.currentBidderId, nom.playerId, nom.playerName,
             nom.playerMeta.nhlTeam || nom.playerMeta.nhl_team || '',
             nom.playerMeta.position || 'F',
             nom.playerMeta.headshotUrl || nom.playerMeta.headshot_url || '',
             nom.playerMeta.crestUrl || nom.playerMeta.crest_url || ''),
      this.env.DB.prepare(
        `UPDATE auction_budgets SET budget_remaining = budget_remaining - ?
         WHERE auction_session_id = ? AND team_id = ?`
      ).bind(nom.currentBid, this.auctionSessionId, nom.currentBidderId),
      this.env.DB.prepare(
        `UPDATE auction_sessions SET current_nomination_json = NULL, current_nominator_idx = ? WHERE id = ?`
      ).bind(nextIdx, this.auctionSessionId),
    ]);

    if (isLast) {
      await this.env.DB.prepare(
        "UPDATE auction_sessions SET status = 'completed', ended_at = ? WHERE id = ?"
      ).bind(now, this.auctionSessionId).run();
      this.status = 'completed';
      await this.state.storage.deleteAlarm();
      this.broadcastAll();
      return;
    }

    this.broadcastAll();

    // Auto-nominate if current nominator is disconnected
    const nominatorTeamId = this.draftOrder[this.nominatorIdx % this.totalTeams]?.teamId;
    const nominatorConnected = [...this.clients.values()].some(c => c.teamId === nominatorTeamId);
    if (!nominatorConnected) await this.autoNominate();
  }

  async autoNominate() {
    const nominatorTeamId = this.draftOrder[this.nominatorIdx % this.totalTeams]?.teamId;
    const roster = this.rosters.get(nominatorTeamId) || { F: 0, D: 0, G: 0 };

    const player = this.globalRankings.find(r => {
      if (this.pickedPlayerIds.has(r.playerId)) return false;
      const p = (r.position || 'F').toUpperCase();
      const cap = p === 'G' ? this.capsG : p === 'D' ? this.capsD : this.capsF;
      return (roster[p] || 0) < cap;
    });

    if (!player) {
      await this.env.DB.prepare(
        "UPDATE auction_sessions SET status = 'completed', ended_at = ? WHERE id = ?"
      ).bind(new Date().toISOString(), this.auctionSessionId).run();
      this.status = 'completed';
      this.broadcastAll();
      return;
    }

    await this._startNomination(nominatorTeamId, player.playerId, player.playerName, {
      position: player.position, nhlTeam: player.nhlTeam,
      headshotUrl: player.headshotUrl, crestUrl: player.crestUrl,
    }, 1);
  }

  snapshot(ws) {
    const sender = this.clients.get(ws);
    const budgetsArr = [...this.budgets].map(([teamId, budgetRemaining]) => ({ teamId, budgetRemaining }));
    const rostersArr = [...this.rosters].map(([teamId, r]) => ({ teamId, F: r.F, D: r.D, G: r.G }));
    return {
      status: this.status,
      nominatorIdx: this.nominatorIdx,
      currentNominatorTeamId: this.draftOrder[this.nominatorIdx % this.totalTeams]?.teamId ?? null,
      currentNomination: this.currentNomination,
      draftOrder: this.draftOrder,
      picks: this.picks,
      budgets: budgetsArr,
      rosters: rostersArr,
      available: this.globalRankings.filter(r => !this.pickedPlayerIds.has(r.playerId)).slice(0, 50),
      myBudget: sender?.teamId != null ? (this.budgets.get(sender.teamId) ?? null) : null,
      myRoster: sender?.teamId != null ? (this.rosters.get(sender.teamId) ?? null) : null,
    };
  }

  send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch {} }

  broadcastAll() {
    for (const [ws] of this.clients) {
      try { ws.send(JSON.stringify({ type: 'state', data: this.snapshot(ws) })); } catch {}
    }
  }
}
```

- [ ] **Step 2: Add re-export to worker/index.js**

Find the existing line `export { DraftRoom } from './draft-room.js';` near the top of `worker/index.js` (after auth imports) and add immediately after it:

```js
export { AuctionRoom } from './auction-room.js';
```

- [ ] **Step 3: Verify syntax**

```
node --check worker/auction-room.js && node --check worker/index.js
```

Expected: no output (exit 0 for both).

- [ ] **Step 4: Commit**

```
git add worker/auction-room.js worker/index.js
git commit -m "feat: AuctionRoom Durable Object — nomination cycle, bid timer, auto-nominate, award"
```

---

### Task 3: Worker REST routes for auction

**Files:**
- Modify: `worker/index.js` only

**Interfaces:**
- Consumes: `env.AUCTION_ROOM`, `loadLeagueContext`, `isCommissioner`, `parseId`, `mergeConfig`, `normalizeHeadshotUrl`, `NHL_BASE` — all already defined in `worker/index.js`
- Produces: 8 REST routes under `/api/leagues/:id/auction/` + stalled-auction cron

- [ ] **Step 1: Insert auction routes block**

Find the comment `// ── Waivers` in `worker/index.js` (around line 1388) and insert the following block immediately before it:

```js
  // ── Auction ───────────────────────────────────────────────────────────────

  // POST /api/leagues/:id/auction/session — create or reset pending session
  if (method === 'POST' && pathname.match(/^\/api\/leagues\/\d+\/auction\/session$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id))
      return json({ error: 'Commissioner only' }, { status: 403 });

    const existing = await db.prepare('SELECT id, status FROM auction_sessions WHERE league_id = ?').bind(leagueId).first();
    if (existing) {
      if (existing.status !== 'pending')
        return json({ error: 'Cannot reset an active or completed auction session' }, { status: 400 });
      await db.prepare(
        "UPDATE auction_sessions SET draft_order_json = '[]', current_nominator_idx = 0, current_nomination_json = NULL WHERE id = ?"
      ).bind(existing.id).run();
      return json({ id: existing.id });
    }
    const config = mergeConfig(ctx.league.config_json);
    const session = await db.prepare(
      'INSERT INTO auction_sessions (league_id, budget_per_team, bid_timer_seconds) VALUES (?, ?, ?) RETURNING id'
    ).bind(leagueId, config.auction_budget, config.bid_timer_seconds).first();
    return json({ id: session.id });
  }

  // GET /api/leagues/:id/auction/session
  if (method === 'GET' && pathname.match(/^\/api\/leagues\/\d+\/auction\/session$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;

    const session = await db.prepare('SELECT * FROM auction_sessions WHERE league_id = ?').bind(leagueId).first();
    if (!session) return json({ session: null, picks: [], myBudget: null });

    session.draft_order = JSON.parse(session.draft_order_json || '[]');
    session.current_nomination = session.current_nomination_json
      ? JSON.parse(session.current_nomination_json) : null;

    const { results: picks } = await db.prepare(
      'SELECT * FROM auction_picks WHERE auction_session_id = ? ORDER BY pick_number'
    ).bind(session.id).all();
    const parsedPicks = (picks || []).map(p => ({ ...p, player_meta: JSON.parse(p.player_meta_json || '{}') }));

    const myTeam = await db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id = ?')
      .bind(leagueId, ctx.user.id).first();
    const myBudget = myTeam
      ? await db.prepare('SELECT budget_remaining FROM auction_budgets WHERE auction_session_id = ? AND team_id = ?')
          .bind(session.id, myTeam.id).first()
      : null;

    return json({ session, picks: parsedPicks, myBudget: myBudget?.budget_remaining ?? null });
  }

  // PUT /api/leagues/:id/auction/session/order
  if (method === 'PUT' && pathname.match(/^\/api\/leagues\/\d+\/auction\/session\/order$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id))
      return json({ error: 'Commissioner only' }, { status: 403 });

    const session = await db.prepare('SELECT id, status FROM auction_sessions WHERE league_id = ?').bind(leagueId).first();
    if (!session) return json({ error: 'No auction session' }, { status: 404 });
    if (session.status !== 'pending') return json({ error: 'Session already started' }, { status: 400 });

    const body = await request.json();
    const { order } = body;
    if (!Array.isArray(order)) return json({ error: 'order must be an array' }, { status: 400 });

    const { results: leagueTeams } = await db.prepare('SELECT id FROM teams WHERE league_id = ?').bind(leagueId).all();
    const validIds = new Set((leagueTeams || []).map(t => t.id));
    for (const entry of order) {
      if (!validIds.has(entry.teamId)) return json({ error: `Unknown team id: ${entry.teamId}` }, { status: 400 });
    }

    await db.prepare('UPDATE auction_sessions SET draft_order_json = ? WHERE id = ?')
      .bind(JSON.stringify(order), session.id).run();
    return json({ ok: true });
  }

  // POST /api/leagues/:id/auction/session/randomize
  if (method === 'POST' && pathname.match(/^\/api\/leagues\/\d+\/auction\/session\/randomize$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id))
      return json({ error: 'Commissioner only' }, { status: 403 });

    const session = await db.prepare('SELECT id, status FROM auction_sessions WHERE league_id = ?').bind(leagueId).first();
    if (!session) return json({ error: 'No auction session' }, { status: 404 });
    if (session.status !== 'pending') return json({ error: 'Session already started' }, { status: 400 });

    const { results: teams } = await db.prepare('SELECT id, name FROM teams WHERE league_id = ?').bind(leagueId).all();
    const order = (teams || [])
      .map(t => ({ teamId: t.id, teamName: t.name }))
      .sort(() => Math.random() - 0.5);
    await db.prepare('UPDATE auction_sessions SET draft_order_json = ? WHERE id = ?')
      .bind(JSON.stringify(order), session.id).run();
    return json({ order });
  }

  // POST /api/leagues/:id/auction/session/start
  if (method === 'POST' && pathname.match(/^\/api\/leagues\/\d+\/auction\/session\/start$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id))
      return json({ error: 'Commissioner only' }, { status: 403 });

    const session = await db.prepare('SELECT * FROM auction_sessions WHERE league_id = ?').bind(leagueId).first();
    if (!session) return json({ error: 'No auction session' }, { status: 404 });
    if (session.status !== 'pending') return json({ error: 'Session already started' }, { status: 400 });

    const draftOrder = JSON.parse(session.draft_order_json || '[]');
    if (draftOrder.length === 0) return json({ error: 'Draft order not set' }, { status: 400 });

    // Seed player rankings from NHL API (same pattern as snake draft)
    try {
      const [skatersRes, goaliesRes] = await Promise.all([
        fetch(`${NHL_BASE}/leaders/skaters/points?limit=200&season=20252026&gameType=3`),
        fetch(`${NHL_BASE}/leaders/goalies/wins?limit=30&season=20252026&gameType=3`),
      ]);
      const [skatersData, goaliesData] = await Promise.all([skatersRes.json(), goaliesRes.json()]);

      const rankInserts = [];
      let rank = 1;
      for (const s of (skatersData?.skaterPoints || [])) {
        const pid = s.id || s.playerId;
        const pname = s.name?.default || `${s.firstName?.default || ''} ${s.lastName?.default || ''}`.trim();
        const pos = s.positionCode || 'F';
        const headshot = normalizeHeadshotUrl(s.headshot || '');
        const meta = JSON.stringify({ position: pos, nhl_team: s.teamAbbrevs || '', headshot_url: headshot, crest_url: '' });
        rankInserts.push(db.prepare(
          'INSERT OR IGNORE INTO auction_player_rankings (auction_session_id, player_id, player_name, player_meta_json, global_rank) VALUES (?, ?, ?, ?, ?)'
        ).bind(session.id, pid, pname, meta, rank++));
      }
      for (const g of (goaliesData?.goalieWins || [])) {
        const pid = g.id || g.playerId;
        const pname = g.name?.default || `${g.firstName?.default || ''} ${g.lastName?.default || ''}`.trim();
        const headshot = normalizeHeadshotUrl(g.headshot || '');
        const meta = JSON.stringify({ position: 'G', nhl_team: g.teamAbbrevs || '', headshot_url: headshot, crest_url: '' });
        rankInserts.push(db.prepare(
          'INSERT OR IGNORE INTO auction_player_rankings (auction_session_id, player_id, player_name, player_meta_json, global_rank) VALUES (?, ?, ?, ?, ?)'
        ).bind(session.id, pid, pname, meta, rank++));
      }
      for (let i = 0; i < rankInserts.length; i += 100) {
        await db.batch(rankInserts.slice(i, i + 100));
      }
    } catch (e) {
      console.error('[auction/start] rankings seed failed:', e?.message);
    }

    // Init budgets for all teams in draft order
    const budgetInserts = draftOrder.map(t =>
      db.prepare('INSERT OR REPLACE INTO auction_budgets (auction_session_id, team_id, budget_remaining) VALUES (?, ?, ?)')
        .bind(session.id, t.teamId, session.budget_per_team)
    );
    if (budgetInserts.length > 0) await db.batch(budgetInserts);

    const now = new Date().toISOString();
    await db.prepare(
      "UPDATE auction_sessions SET status = 'active', started_at = ? WHERE id = ?"
    ).bind(now, session.id).run();

    // Trigger DO alarm-reset so it rehydrates and waits for first nomination
    const doId = env.AUCTION_ROOM.idFromName(`league-${leagueId}`);
    const stub = env.AUCTION_ROOM.get(doId);
    await stub.fetch(new Request('https://internal/alarm-reset', {
      method: 'POST',
      headers: { 'X-League-Id': String(leagueId) },
    }));

    return json({ ok: true });
  }

  // GET /api/leagues/:id/auction/ws — WebSocket proxy
  if (method === 'GET' && pathname.match(/^\/api\/leagues\/\d+\/auction\/ws$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;

    const myTeam = await db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id = ?')
      .bind(leagueId, ctx.user.id).first();
    const isComm = isCommissioner(ctx.league, ctx.role, ctx.user.id);

    const doId = env.AUCTION_ROOM.idFromName(`league-${leagueId}`);
    const stub = env.AUCTION_ROOM.get(doId);
    return stub.fetch(new Request(request.url, {
      headers: new Headers({
        ...Object.fromEntries(request.headers),
        'X-League-Id': String(leagueId),
        'X-User-Id':   String(ctx.user.id),
        'X-Team-Id':   String(myTeam?.id ?? ''),
        'X-Is-Commissioner': String(isComm),
      }),
    }));
  }

  // POST /api/leagues/:id/auction/session/pause
  if (method === 'POST' && pathname.match(/^\/api\/leagues\/\d+\/auction\/session\/pause$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id))
      return json({ error: 'Commissioner only' }, { status: 403 });

    await db.prepare("UPDATE auction_sessions SET status = 'paused' WHERE league_id = ?").bind(leagueId).run();
    const doId = env.AUCTION_ROOM.idFromName(`league-${leagueId}`);
    await env.AUCTION_ROOM.get(doId).fetch(new Request('https://internal/pause', {
      method: 'POST',
      headers: { 'X-League-Id': String(leagueId) },
    }));
    return json({ ok: true });
  }

  // POST /api/leagues/:id/auction/session/resume
  if (method === 'POST' && pathname.match(/^\/api\/leagues\/\d+\/auction\/session\/resume$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id))
      return json({ error: 'Commissioner only' }, { status: 403 });

    await db.prepare("UPDATE auction_sessions SET status = 'active' WHERE league_id = ?").bind(leagueId).run();
    const doId = env.AUCTION_ROOM.idFromName(`league-${leagueId}`);
    await env.AUCTION_ROOM.get(doId).fetch(new Request('https://internal/alarm-reset', {
      method: 'POST',
      headers: { 'X-League-Id': String(leagueId) },
    }));
    return json({ ok: true });
  }

```

- [ ] **Step 2: Add stalled-auction cron recovery**

Find the stalled-draft cron block in `worker/index.js` (around line 2824, inside the per-league cron loop). It ends with:

```js
        } catch (err) {
          console.error(`[cron] league ${league.id} stalled draft recovery failed:`, err?.message ?? err);
        }
```

Add immediately after that closing brace:

```js
        try {
          const stalledAuction = await db.prepare(`
            SELECT id FROM auction_sessions
            WHERE status = 'active' AND league_id = ?
              AND current_nomination_json IS NOT NULL
              AND json_extract(current_nomination_json, '$.bidDeadline') < datetime('now', '-2 minutes')
          `).bind(league.id).first();
          if (stalledAuction) {
            const doId = env.AUCTION_ROOM.idFromName(`league-${league.id}`);
            const stub = env.AUCTION_ROOM.get(doId);
            await stub.fetch(new Request('https://internal/alarm-reset', {
              method: 'POST',
              headers: { 'X-League-Id': String(league.id) },
            }));
          }
        } catch (err) {
          console.error(`[cron] league ${league.id} stalled auction recovery failed:`, err?.message ?? err);
        }
```

- [ ] **Step 3: Verify syntax**

```
node --check worker/index.js
```

Expected: no output (exit 0).

- [ ] **Step 4: Commit**

```
git add worker/index.js
git commit -m "feat: auction REST routes — session CRUD, order, start, WS proxy, pause/resume, cron recovery"
```

---

### Task 4: API client + route + nav + placeholder page

**Files:**
- Modify: `client/src/api.js`
- Modify: `client/src/App.jsx`
- Modify: `client/src/components/LeagueLayout.jsx`
- Create: `client/src/pages/AuctionPage.jsx`

**Interfaces:**
- Consumes: Task 3 REST routes
- Produces: `api.leagues.auction.*`; `/leagues/:id/auction` route; "Auction" nav link; placeholder `AuctionPage`

- [ ] **Step 1: Add api.leagues.auction to client/src/api.js**

Find `api.leagues` object and, after the `draft: { ... }` block, add:

```js
    auction: {
      getSession: (id) => get(`/api/leagues/${id}/auction/session`),
      create:     (id) => post(`/api/leagues/${id}/auction/session`),
      setOrder:   (id, order) => put(`/api/leagues/${id}/auction/session/order`, { order }),
      randomize:  (id) => post(`/api/leagues/${id}/auction/session/randomize`),
      start:      (id) => post(`/api/leagues/${id}/auction/session/start`),
      pause:      (id) => post(`/api/leagues/${id}/auction/session/pause`),
      resume:     (id) => post(`/api/leagues/${id}/auction/session/resume`),
      connect:    (id) => new WebSocket(
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/leagues/${id}/auction/ws`
      ),
    },
```

- [ ] **Step 2: Add route to client/src/App.jsx**

Add import after the DraftPage import:

```js
import AuctionPage from './pages/AuctionPage.jsx';
```

Add route after `<Route path="draft" element={<DraftPage />} />`:

```jsx
<Route path="auction" element={<AuctionPage />} />
```

- [ ] **Step 3: Add nav link to client/src/components/LeagueLayout.jsx**

Find the "Draft" NavLink and add immediately after it:

```jsx
<NavLink to={`/leagues/${leagueId}/auction`} className={({ isActive }) => tab(isActive)}>Auction</NavLink>
```

- [ ] **Step 4: Create placeholder AuctionPage**

Create `client/src/pages/AuctionPage.jsx`:

```jsx
import { useParams } from 'react-router-dom';

export default function AuctionPage() {
  const { leagueId } = useParams();
  return (
    <div className="page-content">
      <p>Auction — league {leagueId} — coming soon</p>
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```
git add client/src/api.js client/src/App.jsx client/src/components/LeagueLayout.jsx client/src/pages/AuctionPage.jsx
git commit -m "feat: auction API client methods, route, nav link, placeholder page"
```

---

### Task 5: useAuctionSocket hook

**Files:**
- Create: `client/src/hooks/useAuctionSocket.js`

**Interfaces:**
- Consumes: `api.leagues.auction.connect(leagueId)` → `WebSocket`
- Produces: `useAuctionSocket(leagueId)` → `{ state, send, connected, error }`
  - `state`: latest `msg.data` from `{ type: 'state', data: {...} }` messages, or `null`
  - `send(msg)`: no-ops if WS not OPEN; JSON-serializes and sends
  - `connected`: boolean
  - `error`: string or null

- [ ] **Step 1: Create client/src/hooks/useAuctionSocket.js**

```js
import { useState, useEffect, useRef, useCallback } from 'react';
import api from '../api';

const MAX_RETRIES = 5;

export function useAuctionSocket(leagueId) {
  const [state, setState] = useState(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const wsRef = useRef(null);
  const retriesRef = useRef(0);

  const connect = useCallback(() => {
    const ws = api.leagues.auction.connect(leagueId);
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
      if (retriesRef.current < MAX_RETRIES) {
        const delay = Math.min(100 * Math.pow(2, retriesRef.current), 10000);
        retriesRef.current += 1;
        setTimeout(connect, delay);
      } else {
        setError('Connection lost. Please refresh.');
      }
    };

    ws.onerror = () => {
      setConnected(false);
    };
  }, [leagueId]);

  useEffect(() => {
    connect();
    return () => {
      retriesRef.current = MAX_RETRIES;
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

export default useAuctionSocket;
```

- [ ] **Step 2: Commit**

```
git add client/src/hooks/useAuctionSocket.js
git commit -m "feat: useAuctionSocket hook with exponential backoff reconnect"
```

---

### Task 6: AuctionPage — PreAuctionLobby (pending state)

**Files:**
- Modify: `client/src/pages/AuctionPage.jsx` (replace placeholder)

**Interfaces:**
- Consumes: `api.leagues.auction.*`; `useAuctionSocket(leagueId)`; `useParams`, `useOutletContext` from react-router-dom
- Produces: Full `AuctionPage` with pending state; `PreAuctionLobby` sub-component

- [ ] **Step 1: Replace AuctionPage.jsx with full implementation**

```jsx
import { useState, useEffect } from 'react';
import { useParams, useOutletContext } from 'react-router-dom';
import api from '../api';
import { useAuctionSocket } from '../hooks/useAuctionSocket';

function PreAuctionLobby({ leagueId, initialSession, isCommissioner, onStart }) {
  const [draftOrder, setDraftOrder] = useState(
    initialSession?.draft_order || []
  );
  const [msg, setMsg] = useState('');

  async function createSession() {
    try {
      await api.leagues.auction.create(leagueId);
      const data = await api.leagues.auction.getSession(leagueId);
      setDraftOrder(data?.session?.draft_order || []);
      setMsg('Session created.');
    } catch (e) { setMsg(e.message); }
  }

  async function randomize() {
    try {
      const data = await api.leagues.auction.randomize(leagueId);
      setDraftOrder(data?.order || []);
      setMsg('Order randomized.');
    } catch (e) { setMsg(e.message); }
  }

  async function startAuction() {
    try {
      await api.leagues.auction.start(leagueId);
      onStart();
    } catch (e) { setMsg(e.message); }
  }

  const allSlotsFilled = draftOrder.length > 0 && draftOrder.every(t => t.teamId);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Auction Draft Setup</h2>

      {isCommissioner ? (
        <>
          {!initialSession && (
            <button onClick={createSession} style={{ marginBottom: '1rem' }}>
              Create Auction Session
            </button>
          )}

          {initialSession && (
            <>
              <div style={{ marginBottom: '1rem' }}>
                <h3>Draft Order</h3>
                {draftOrder.length === 0 && <p className="st-dim">No order set yet.</p>}
                <ol>
                  {draftOrder.map((t, i) => (
                    <li key={t.teamId}>{t.teamName}</li>
                  ))}
                </ol>
                <button onClick={randomize} style={{ marginRight: '0.5rem' }}>
                  Randomize Order
                </button>
              </div>

              <button
                onClick={startAuction}
                disabled={!allSlotsFilled}
                style={{ opacity: allSlotsFilled ? 1 : 0.5 }}
              >
                Start Auction
              </button>
            </>
          )}

          {msg && <p style={{ color: '#e67e22', marginTop: '0.5rem' }}>{msg}</p>}
        </>
      ) : (
        <p className="st-dim">Waiting for the commissioner to start the auction.</p>
      )}
    </div>
  );
}

export default function AuctionPage() {
  const { leagueId } = useParams();
  const { user } = useOutletContext();
  const [initialData, setInitialData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isCommissioner, setIsCommissioner] = useState(false);
  const [myTeamId, setMyTeamId] = useState(null);
  const { state: wsState, send, connected, error: wsError } = useAuctionSocket(leagueId);

  useEffect(() => {
    async function load() {
      try {
        const [sessionData, teamsData, leagueInfo] = await Promise.all([
          api.leagues.auction.getSession(leagueId),
          api.leagues.getTeams(leagueId),
          api.leagues.get(leagueId),
        ]);
        setInitialData({ ...sessionData, teams: teamsData || [] });
        setIsCommissioner(leagueInfo?.owner_user_id === user?.id || leagueInfo?.my_role === 'commissioner');
        const mine = (teamsData || []).find(t => t.user_id === user?.id);
        if (mine) setMyTeamId(mine.id);
      } catch {}
      setLoading(false);
    }
    load();
  }, [leagueId, user]);

  if (loading) return <div className="page-content"><p>Loading auction…</p></div>;

  const auctionStatus = wsState?.status || initialData?.session?.status || null;

  if (!auctionStatus || auctionStatus === 'pending') {
    return (
      <div className="page-content">
        <PreAuctionLobby
          leagueId={leagueId}
          initialSession={initialData?.session}
          isCommissioner={isCommissioner}
          onStart={() => window.location.reload()}
        />
      </div>
    );
  }

  // Active/paused/completed — Task 7 will replace this stub
  return (
    <div className="page-content">
      <p>Auction is live — status: {auctionStatus}</p>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```
git add client/src/pages/AuctionPage.jsx
git commit -m "feat: AuctionPage shell with PreAuctionLobby — create session, randomize order, start auction"
```

---

### Task 7: AuctionPage — active auction room

**Files:**
- Modify: `client/src/pages/AuctionPage.jsx` (replace the "Task 7 stub" block)

**Interfaces:**
- Consumes: `wsState` from `useAuctionSocket` with shape:
  ```js
  {
    status,                   // 'active' | 'paused' | 'completed'
    nominatorIdx,             // integer
    currentNominatorTeamId,   // integer or null
    currentNomination,        // {playerId, playerName, playerMeta, nominatedByTeamId, currentBid, currentBidderId, bidDeadline} or null
    draftOrder,               // [{teamId, teamName}]
    picks,                    // [{pickNumber, teamId, amount, playerName, playerMeta, nominatedByTeamId, pickedAt, ...}]
    budgets,                  // [{teamId, budgetRemaining}]
    rosters,                  // [{teamId, F, D, G}]
    available,                // [{playerId, playerName, position, nhlTeam, headshotUrl}]
    myBudget,                 // integer or null
    myRoster,                 // {F, D, G} or null
  }
  ```
- `send(msg)` sends WS messages: `{type:'nominate', playerId, playerName, playerMeta, openingBid}`, `{type:'bid', amount}`

- [ ] **Step 1: Add sub-components and replace active-state stub**

Replace the active/paused/completed stub in `AuctionPage.jsx` (the `return` block after `if (!auctionStatus || auctionStatus === 'pending')`) with the following. Add the sub-component functions BEFORE `export default function AuctionPage()`:

```jsx
function AuctionTimerBar({ bidDeadline, status, nominatorName }) {
  const [secsLeft, setSecsLeft] = useState(null);

  useEffect(() => {
    if (status === 'completed') { setSecsLeft(null); return; }
    if (!bidDeadline) { setSecsLeft(null); return; }
    const tick = () => {
      const diff = Math.max(0, Math.floor((new Date(bidDeadline) - Date.now()) / 1000));
      setSecsLeft(diff);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [bidDeadline, status]);

  if (status === 'paused') return <div style={{ background: '#e67e22', padding: '6px 12px', borderRadius: 4, color: '#fff', fontWeight: 'bold', marginBottom: '0.75rem' }}>PAUSED</div>;
  if (status === 'completed' || secsLeft === null) return null;

  const color = secsLeft <= 5 ? '#e74c3c' : secsLeft <= 10 ? '#e67e22' : '#27ae60';
  return (
    <div style={{ marginBottom: '0.75rem' }}>
      {nominatorName && <span style={{ color: '#888', fontSize: '0.85rem' }}>On the clock: {nominatorName} — </span>}
      <span style={{ color, fontWeight: 'bold', fontSize: '1.1rem' }}>{secsLeft}s</span>
    </div>
  );
}

function NominationPanel({ nomination, draftOrder }) {
  if (!nomination) return <div style={{ padding: '1rem', border: '1px solid #333', borderRadius: 6, textAlign: 'center', color: '#888' }}>Waiting for nomination…</div>;

  const bidderName = draftOrder.find(t => t.teamId === nomination.currentBidderId)?.teamName || 'Unknown';
  return (
    <div style={{ padding: '1rem', border: '2px solid #f1c40f', borderRadius: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        {nomination.playerMeta?.headshotUrl && (
          <img src={nomination.playerMeta.headshotUrl} alt="" style={{ width: 48, height: 48, borderRadius: '50%' }} />
        )}
        <div>
          <div style={{ fontWeight: 'bold', fontSize: '1.1rem' }}>{nomination.playerName}</div>
          <div style={{ color: '#888', fontSize: '0.8rem' }}>
            {nomination.playerMeta?.position} · {nomination.playerMeta?.nhlTeam}
          </div>
        </div>
      </div>
      <div style={{ marginTop: '0.75rem', fontSize: '1.4rem', fontWeight: 'bold', color: '#f1c40f' }}>
        ${nomination.currentBid}
        <span style={{ fontSize: '0.85rem', color: '#888', fontWeight: 'normal', marginLeft: 8 }}>
          — {bidderName}
        </span>
      </div>
    </div>
  );
}

function NominatePanel({ available, myBudget, myRoster, capsF, capsD, capsG, send }) {
  const [search, setSearch] = useState('');
  const [openingBid, setOpeningBid] = useState(1);

  const rosterTotal = (myRoster?.F || 0) + (myRoster?.D || 0) + (myRoster?.G || 0);
  const remainingSlots = capsF + capsD + capsG - rosterTotal;
  const maxBid = Math.max(1, (myBudget ?? 0) - remainingSlots + 1);

  const filtered = (available || []).filter(p =>
    !search || p.playerName.toLowerCase().includes(search.toLowerCase())
  );

  function nominate(p) {
    send({
      type: 'nominate',
      playerId: p.playerId,
      playerName: p.playerName,
      playerMeta: { position: p.position, nhlTeam: p.nhlTeam, headshotUrl: p.headshotUrl, crestUrl: p.crestUrl || '' },
      openingBid: Number(openingBid),
    });
  }

  return (
    <div style={{ border: '1px solid #2ecc71', borderRadius: 6, padding: '0.75rem' }}>
      <h4 style={{ marginTop: 0, color: '#2ecc71' }}>Your turn to nominate</h4>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <input
          placeholder="Search players…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1 }}
        />
        <input
          type="number"
          min={1}
          max={maxBid}
          value={openingBid}
          onChange={e => setOpeningBid(e.target.value)}
          style={{ width: 70 }}
        />
      </div>
      <div style={{ maxHeight: 200, overflowY: 'auto' }}>
        {filtered.slice(0, 50).map(p => (
          <div key={p.playerId} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '3px 0', borderBottom: '1px solid #333' }}>
            <span style={{ flex: 1, fontSize: '0.85rem' }}>
              <span style={{ color: '#888', fontSize: '0.75rem', marginRight: 4 }}>{p.position}</span>
              {p.playerName}
            </span>
            <button onClick={() => nominate(p)} style={{ fontSize: '0.75rem', padding: '2px 8px' }}>
              Nominate
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function TeamsSidebar({ draftOrder, budgets, rosters, capsF, capsD, capsG }) {
  const budgetMap = Object.fromEntries((budgets || []).map(b => [b.teamId, b.budgetRemaining]));
  const rosterMap = Object.fromEntries((rosters || []).map(r => [r.teamId, r]));
  const totalSlots = capsF + capsD + capsG;

  return (
    <div style={{ border: '1px solid #333', borderRadius: 6, padding: '0.75rem' }}>
      <h4 style={{ marginTop: 0 }}>Teams</h4>
      {(draftOrder || []).map(t => {
        const r = rosterMap[t.teamId] || { F: 0, D: 0, G: 0 };
        const filled = r.F + r.D + r.G;
        const budget = budgetMap[t.teamId] ?? '—';
        return (
          <div key={t.teamId} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #222', fontSize: '0.85rem' }}>
            <span>{t.teamName}</span>
            <span style={{ color: '#888' }}>${budget} · {filled}/{totalSlots}</span>
          </div>
        );
      })}
    </div>
  );
}

function PicksFeed({ picks, draftOrder }) {
  const teamMap = Object.fromEntries((draftOrder || []).map(t => [t.teamId, t.teamName]));
  const sorted = [...(picks || [])].reverse();
  return (
    <div style={{ border: '1px solid #333', borderRadius: 6, padding: '0.75rem', maxHeight: 300, overflowY: 'auto' }}>
      <h4 style={{ marginTop: 0 }}>Picks</h4>
      {sorted.length === 0 && <p className="st-dim">No picks yet.</p>}
      {sorted.map(p => (
        <div key={p.pick_number || p.pickNumber} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid #222', fontSize: '0.82rem' }}>
          <span>
            <span style={{ color: '#888', fontSize: '0.7rem', marginRight: 4 }}>{p.playerMeta?.position || p.player_meta?.position}</span>
            {p.playerName || p.player_name}
          </span>
          <span style={{ color: '#888' }}>{teamMap[p.teamId || p.team_id]} · <span style={{ color: '#f1c40f' }}>${p.amount}</span></span>
        </div>
      ))}
    </div>
  );
}
```

Then replace the stub `return` block in `AuctionPage` (the `// Active/paused/completed — Task 7 will replace this stub` block) with:

```jsx
  const liveState = wsState || {
    status: initialData?.session?.status,
    nominatorIdx: initialData?.session?.current_nominator_idx || 0,
    currentNominatorTeamId: null,
    currentNomination: initialData?.session?.current_nomination,
    draftOrder: initialData?.session?.draft_order || [],
    picks: initialData?.picks || [],
    budgets: [],
    rosters: [],
    available: [],
    myBudget: initialData?.myBudget ?? null,
    myRoster: myTeamId ? null : null,
  };

  const capsF = 10; const capsD = 5; const capsG = 3;
  const isMyTurn = myTeamId && liveState.currentNominatorTeamId === myTeamId && liveState.status === 'active';
  const nomination = liveState.currentNomination;
  const nominatorName = liveState.draftOrder.find(t => t.teamId === liveState.currentNominatorTeamId)?.teamName;

  // Bid controls
  const nextBidAmount = (nomination?.currentBid || 0) + 1;
  const myRoster = liveState.rosters?.find?.(r => r.teamId === myTeamId) || liveState.myRoster || { F: 0, D: 0, G: 0 };
  const myBudget = liveState.myBudget ?? (liveState.budgets?.find?.(b => b.teamId === myTeamId)?.budgetRemaining ?? null);
  const rosterTotal = (myRoster?.F || 0) + (myRoster?.D || 0) + (myRoster?.G || 0);
  const remainingSlots = capsF + capsD + capsG - rosterTotal;
  const myMaxBid = myBudget != null ? myBudget - remainingSlots + 1 : 0;
  const nomPos = (nomination?.playerMeta?.position || 'F').toUpperCase();
  const myPosCount = myRoster?.[nomPos] || 0;
  const myPosCap = nomPos === 'G' ? capsG : nomPos === 'D' ? capsD : capsF;
  const canBid = nomination &&
    liveState.status === 'active' &&
    myTeamId &&
    remainingSlots > 0 &&
    myPosCount < myPosCap &&
    nextBidAmount <= myMaxBid &&
    nomination.currentBidderId !== myTeamId;

  return (
    <div className="page-content">
      {wsError && <p className="alert">{wsError}</p>}
      {!connected && liveState.status === 'active' && <p className="st-dim">Reconnecting…</p>}

      <AuctionTimerBar
        bidDeadline={nomination?.bidDeadline}
        status={liveState.status}
        nominatorName={nominatorName}
      />

      {liveState.status === 'completed' && (
        <p style={{ color: '#27ae60', fontWeight: 'bold', margin: '0.5rem 0' }}>Auction Complete!</p>
      )}

      {isCommissioner && liveState.status === 'active' && (
        <button onClick={() => api.leagues.auction.pause(leagueId)} style={{ marginBottom: '0.75rem' }}>Pause Auction</button>
      )}
      {isCommissioner && liveState.status === 'paused' && (
        <button onClick={() => api.leagues.auction.resume(leagueId)} style={{ marginBottom: '0.75rem' }}>Resume Auction</button>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: '1rem' }}>
        <div>
          <NominationPanel nomination={nomination} draftOrder={liveState.draftOrder} />

          {canBid && (
            <div style={{ marginTop: '0.75rem' }}>
              <button
                onClick={() => send({ type: 'bid', amount: nextBidAmount })}
                style={{ fontSize: '1rem', padding: '0.5rem 1.5rem', background: '#2980b9', border: 'none', color: '#fff', borderRadius: 4, cursor: 'pointer' }}
              >
                Bid ${nextBidAmount}
              </button>
            </div>
          )}

          {isMyTurn && !nomination && (
            <div style={{ marginTop: '0.75rem' }}>
              <NominatePanel
                available={liveState.available}
                myBudget={myBudget}
                myRoster={myRoster}
                capsF={capsF} capsD={capsD} capsG={capsG}
                send={send}
              />
            </div>
          )}

          <div style={{ marginTop: '1rem' }}>
            <PicksFeed picks={liveState.picks} draftOrder={liveState.draftOrder} />
          </div>
        </div>

        <div>
          {myBudget != null && (
            <div style={{ border: '1px solid #333', borderRadius: 6, padding: '0.75rem', marginBottom: '1rem' }}>
              <div style={{ fontSize: '0.85rem', color: '#888' }}>My Budget</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 'bold', color: '#f1c40f' }}>${myBudget}</div>
              <div style={{ fontSize: '0.75rem', color: '#888' }}>{remainingSlots} slots remaining</div>
            </div>
          )}
          <TeamsSidebar
            draftOrder={liveState.draftOrder}
            budgets={liveState.budgets}
            rosters={liveState.rosters}
            capsF={capsF} capsD={capsD} capsG={capsG}
          />
        </div>
      </div>
    </div>
  );
```

Also add `useState` to the React import at the top of the file (it's needed by sub-components):

```jsx
import { useState, useEffect } from 'react';
```

- [ ] **Step 2: Commit**

```
git add client/src/pages/AuctionPage.jsx
git commit -m "feat: AuctionPage active room — nomination panel, bid button, nominate panel, teams sidebar, picks feed"
```

---

### Task 8: CommissionerDashboard — Auction Setup section

**Files:**
- Modify: `client/src/pages/CommissionerDashboard.jsx`

**Interfaces:**
- Consumes: `api.leagues.auction.getSession`, `api.leagues.auction.create`; `api.leagues.update` (already exists) for config fields; `leagueId` from `useParams`; `league` from outlet context

- [ ] **Step 1: Add Auction Setup section to CommissionerDashboard.jsx**

Read the file first. Find the three existing state vars for the Draft Setup section (lines like `const [draftSession, setDraftSession] = useState(null)`). Add after the draft state block:

```js
const [auctionSession, setAuctionSession] = useState(null);
const [auctionMsg, setAuctionMsg] = useState('');
const [auctionBudget, setAuctionBudget] = useState(() => league.config?.auction_budget ?? 1000);
const [bidTimer, setBidTimer] = useState(() => league.config?.bid_timer_seconds ?? 30);
```

Find the existing `useEffect` that loads the draft session. Add a parallel `useEffect` for auction immediately after it:

```js
useEffect(() => {
  api.leagues.auction.getSession(leagueId).then(data => {
    if (data?.session) setAuctionSession(data.session);
  }).catch(() => {});
}, [leagueId]);
```

Add handler functions after `savePickTimer`:

```js
async function createAuctionSession() {
  try {
    await api.leagues.auction.create(leagueId);
    const data = await api.leagues.auction.getSession(leagueId);
    setAuctionSession(data?.session || null);
    setAuctionMsg('Auction session created.');
  } catch (e) { setAuctionMsg(e.message); }
}

async function saveAuctionConfig() {
  try {
    await api.leagues.update(leagueId, {
      config: { auction_budget: parseInt(auctionBudget), bid_timer_seconds: parseInt(bidTimer) }
    });
    setAuctionMsg('Auction settings saved.');
  } catch (e) { setAuctionMsg(e.message); }
}
```

Find the Draft Setup JSX section. Add an Auction Setup section immediately after it (before the Members card or whatever follows):

```jsx
<div className="card" style={{ marginTop: '1.5rem' }}>
  <h3 style={{ marginTop: 0 }}>Auction Setup</h3>

  <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '1rem' }}>
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: '0.8rem', color: '#888' }}>Budget per team ($)</span>
      <input
        type="number" min={100} max={10000} step={100}
        value={auctionBudget}
        onChange={e => setAuctionBudget(e.target.value)}
        style={{ width: 100 }}
      />
    </label>
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: '0.8rem', color: '#888' }}>Bid timer (seconds)</span>
      <input
        type="number" min={10} max={120}
        value={bidTimer}
        onChange={e => setBidTimer(e.target.value)}
        style={{ width: 80 }}
      />
    </label>
    <button onClick={saveAuctionConfig}>Save</button>
  </div>

  {!auctionSession ? (
    <button onClick={createAuctionSession}>Create Auction Session</button>
  ) : (
    <p style={{ color: '#888', fontSize: '0.85rem' }}>
      Session status: <strong>{auctionSession.status}</strong> —{' '}
      <a href={`/leagues/${leagueId}/auction`} style={{ color: '#3498db' }}>Go to Auction Room</a>
    </p>
  )}

  {auctionMsg && <p style={{ color: '#e67e22', marginTop: '0.5rem' }}>{auctionMsg}</p>}
</div>
```

- [ ] **Step 2: Commit**

```
git add client/src/pages/CommissionerDashboard.jsx
git commit -m "feat: CommissionerDashboard auction setup — budget, bid timer, create session"
```
