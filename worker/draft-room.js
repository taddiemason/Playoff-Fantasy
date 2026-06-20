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

    // Resolve position from server-side rankings to prevent cap bypass via forged playerMeta
    const ranked = this.globalRankings.find(r => r.playerId === playerId);
    const pos = ranked?.position || playerMeta.position || 'F';
    const roster = this.teamRosters.get(currentTeamId) || { F: 0, D: 0, G: 0 };
    const cap = pos === 'G' ? this.capsG : pos === 'D' ? this.capsD : this.capsF;
    if ((roster[pos] || 0) >= cap) {
      return this.send(ws, { type: 'error', message: `Roster full for position ${pos}` });
    }

    const trustedMeta = { ...playerMeta, position: pos };
    await this.executePick(currentTeamId, { playerId, playerName, playerMeta: trustedMeta }, false);
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
      await this.env.DB.prepare(
        `UPDATE leagues SET phase = CASE WHEN league_format = 'dynasty' THEN 'pre_draft' ELSE 'active' END WHERE id = ?`
      ).bind(this.leagueId).run();
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
      await this.env.DB.prepare(
        `UPDATE leagues SET phase = CASE WHEN league_format = 'dynasty' THEN 'pre_draft' ELSE 'active' END WHERE id = ?`
      ).bind(this.leagueId).run();
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
