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
