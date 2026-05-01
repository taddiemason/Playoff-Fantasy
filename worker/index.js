const CACHE_TTL_MS = 5 * 60 * 1000;
const nhlCache = new Map(); // keyed by player-{id}, cleared on refresh
let lastSuccessfulStandings = null;

// Tracks goalies that have ever had gamesPlayed > 0. Once a goalie is confirmed
// active they stay in the ranking pool even if a transient NHL API response
// comes back without their playoff entry, preventing repeated rank shifts.
const confirmedActiveGoalies = new Map(); // playerId → last known normalized stats

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers || {})
    }
  });
}

function getCurrentSeason() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  return month >= 10 ? `${year}${year + 1}` : `${year - 1}${year}`;
}

const NHL_BASE = 'https://api-web.nhle.com/v1';

function getPlayoffStats(data, season) {
  return (data.seasonTotals || []).find(
    s => s.leagueAbbrev === 'NHL' && s.gameTypeId === 3 && String(s.season) === String(season)
  ) || null;
}

function normalizeSkater(entry, playerId) {
  if (!entry) return null;
  return {
    playerId,
    goals: entry.goals ?? 0,
    assists: entry.assists ?? 0,
    ppGoals: entry.powerPlayGoals ?? 0,
    ppAssists: (entry.powerPlayPoints ?? 0) - (entry.powerPlayGoals ?? 0),
    shGoals: entry.shorthandedGoals ?? 0,
    shAssists: (entry.shorthandedPoints ?? 0) - (entry.shorthandedGoals ?? 0),
    penaltyMinutes: entry.pim ?? 0,
    plusMinus: entry.plusMinus ?? 0,
    gamesPlayed: entry.gamesPlayed ?? 0,
  };
}

function toiToSeconds(toi) {
  if (toi == null) return null;
  if (typeof toi === 'number') return toi;
  if (toi.includes(':')) {
    const [mm, ss] = toi.split(':');
    return parseInt(mm) * 60 + parseInt(ss || '0');
  }
  return parseFloat(toi) || null;
}

function normalizeGoalie(entry, playerId) {
  if (!entry) return null;
  let goalsAgainstAverage = entry.goalsAgainstAvg ?? entry.goalsAgainstAverage ?? entry.gaa ?? null;
  if (goalsAgainstAverage == null && entry.goalsAgainst != null) {
    const toiSec = toiToSeconds(entry.timeOnIce);
    if (toiSec > 0) {
      goalsAgainstAverage = (entry.goalsAgainst / toiSec) * 3600;
    } else if (entry.gamesPlayed > 0) {
      goalsAgainstAverage = entry.goalsAgainst / entry.gamesPlayed;
    }
  }
  return {
    playerId,
    wins: entry.wins ?? 0,
    shutouts: entry.shutouts ?? 0,
    goalsAgainstAverage,
    savePct: entry.savePctg ?? entry.savePct ?? entry.savePercentage ?? null,
    gamesPlayed: entry.gamesPlayed ?? 0,
  };
}

async function cachedNhlFetch(cacheKey, url) {
  const entry = nhlCache.get(cacheKey);
  if (entry && Date.now() - entry.time < CACHE_TTL_MS) return entry.data;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'PlayoffFantasy/1.0 (Cloudflare Worker)' }
    });

    if (!res.ok) throw new Error(`NHL API ${res.status}: ${url}`);

    const data = await res.json();
    nhlCache.set(cacheKey, { data, time: Date.now() });
    return data;
  } catch (err) {
    // Return stale data rather than dropping the player to 0 points
    if (entry) return entry.data;
    throw err;
  }
}

function clearNhlCache() {
  // Mark entries stale so fresh data is fetched, but keep values as fallback
  // in case the NHL API is temporarily unreachable.
  for (const [key, entry] of nhlCache.entries()) {
    nhlCache.set(key, { ...entry, time: 0 });
  }
}

async function getEliminatedTeams(season) {
  try {
    const data = await cachedNhlFetch(`bracket-${season}`, `${NHL_BASE}/playoff-bracket/${season}`);
    const eliminated = new Set();
    for (const round of (data?.rounds || [])) {
      for (const series of (round?.series || [])) {
        const top = series.topSeedTeam;
        const bottom = series.bottomSeedTeam;
        if (!top || !bottom) continue;
        if ((top.wins ?? 0) >= 4) eliminated.add(bottom.abbrev);
        else if ((bottom.wins ?? 0) >= 4) eliminated.add(top.abbrev);
      }
    }
    return [...eliminated];
  } catch {
    return [];
  }
}

function requireAuth(request, env) {
  const expected = env.ADMIN_PASSWORD
  if (!expected) return null
  const auth = request.headers.get('Authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (token !== expected) return json({ error: 'Unauthorized' }, { status: 401 })
  return null
}


function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isFinite(id) ? id : null;
}

async function getTeams(db) {
  const { results } = await db.prepare('SELECT * FROM teams ORDER BY created_at DESC').all();
  return results || [];
}

async function getTeamPlayers(db, teamId) {
  const { results } = await db
    .prepare('SELECT * FROM team_players WHERE team_id = ? ORDER BY id DESC')
    .bind(teamId)
    .all();
  return results || [];
}

async function handleApi(request, env, pathname) {
  const db = env.DB;

  if (pathname === '/api/teams' && request.method === 'GET') {
    return json(await getTeams(db));
  }

  if (pathname === '/api/teams' && request.method === 'POST') {
    const authErr = requireAuth(request, env); if (authErr) return authErr;
    const { name, owner, tiebreaker } = await request.json();
    if (!name?.trim()) return json({ error: 'Team name required' }, { status: 400 });

    try {
      const result = await db
        .prepare('INSERT INTO teams (name, owner, tiebreaker) VALUES (?, ?, ?) RETURNING id, name, owner, tiebreaker')
        .bind(name.trim(), owner?.trim() || '', tiebreaker?.trim() || null)
        .first();
      return json(result);
    } catch (err) {
      const msg = err?.message || '';
      if (msg.includes('UNIQUE') || msg.includes('unique')) {
        return json({ error: 'A team with that name already exists' }, { status: 400 });
      }
      return json({ error: msg || 'Failed to create team' }, { status: 500 });
    }
  }

  const teamMatch = pathname.match(/^\/api\/teams\/(\d+)$/);
  if (teamMatch && request.method === 'PUT') {
    const authErr = requireAuth(request, env); if (authErr) return authErr;
    const teamId = parseId(teamMatch[1]);
    const { name, owner, tiebreaker } = await request.json();
    if (!name?.trim()) return json({ error: 'Team name required' }, { status: 400 });

    try {
      await db
        .prepare('UPDATE teams SET name = ?, owner = ?, tiebreaker = ? WHERE id = ?')
        .bind(name.trim(), owner?.trim() || '', tiebreaker?.trim() || null, teamId)
        .run();
      return json({ success: true });
    } catch {
      return json({ error: 'A team with that name already exists' }, { status: 400 });
    }
  }

  if (teamMatch && request.method === 'DELETE') {
    const authErr = requireAuth(request, env); if (authErr) return authErr;
    const teamId = parseId(teamMatch[1]);
    await db.prepare('DELETE FROM teams WHERE id = ?').bind(teamId).run();
    return json({ success: true });
  }

  const teamPlayersMatch = pathname.match(/^\/api\/teams\/(\d+)\/players$/);
  if (teamPlayersMatch && request.method === 'GET') {
    const teamId = parseId(teamPlayersMatch[1]);
    return json(await getTeamPlayers(db, teamId));
  }

  if (teamPlayersMatch && request.method === 'POST') {
    const authErr = requireAuth(request, env); if (authErr) return authErr;
    const teamId = parseId(teamPlayersMatch[1]);
    const { player_id, player_name, nhl_team, position, position_detail, headshot_url } = await request.json();

    if (!player_id || !player_name || !position) {
      return json({ error: 'Missing required fields' }, { status: 400 });
    }

    const players = await getTeamPlayers(db, teamId);
    const forwards = players.filter((p) => p.position === 'F');
    const defensemen = players.filter((p) => p.position === 'D');
    const goalies = players.filter((p) => p.position === 'G');

    if (position === 'F' && forwards.length >= 10) {
      return json({ error: 'Maximum 10 forwards allowed per team' }, { status: 400 });
    }
    if (position === 'D' && defensemen.length >= 5) {
      return json({ error: 'Maximum 5 defensemen allowed per team' }, { status: 400 });
    }
    if (position === 'G' && goalies.length >= 3) {
      return json({ error: 'Maximum 3 goalies allowed per team' }, { status: 400 });
    }

    if (position === 'F') {
      const fromSameTeam = forwards.filter((p) => p.nhl_team === nhl_team).length;
      if (fromSameTeam >= 3) {
        return json({ error: `Max 3 forwards from ${nhl_team} allowed` }, { status: 400 });
      }
    }
    if (position === 'D') {
      const fromSameTeam = defensemen.filter((p) => p.nhl_team === nhl_team).length;
      if (fromSameTeam >= 2) {
        return json({ error: `Max 2 defensemen from ${nhl_team} allowed` }, { status: 400 });
      }
    }

    try {
      const result = await db
        .prepare(`INSERT INTO team_players
          (team_id, player_id, player_name, nhl_team, position, position_detail, headshot_url)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          RETURNING id, team_id, player_id, player_name, nhl_team, position, position_detail, headshot_url`)
        .bind(teamId, player_id, player_name, nhl_team || '', position, position_detail || '', headshot_url || '')
        .first();

      return json(result);
    } catch {
      return json({ error: 'Player is already on this team' }, { status: 400 });
    }
  }

  const removePlayerMatch = pathname.match(/^\/api\/teams\/(\d+)\/players\/(\d+)$/);
  if (removePlayerMatch && request.method === 'DELETE') {
    const authErr = requireAuth(request, env); if (authErr) return authErr;
    const teamId = parseId(removePlayerMatch[1]);
    const id = parseId(removePlayerMatch[2]);

    await db.prepare('DELETE FROM team_players WHERE id = ? AND team_id = ?').bind(id, teamId).run();
    return json({ success: true });
  }

  if (pathname === '/api/nhl/search' && request.method === 'GET') {
    const url = new URL(request.url);
    const q = url.searchParams.get('q') || '';
    if (!q.trim()) return json([]);
    const { results } = await db
      .prepare(
        `SELECT DISTINCT player_id, player_name, nhl_team, position, position_detail, headshot_url
         FROM team_players WHERE player_name LIKE ? ORDER BY player_name LIMIT 20`
      )
      .bind(`%${q.trim()}%`)
      .all();
    return json((results || []).map(p => ({
      playerId: p.player_id,
      name: p.player_name,
      positionCode: p.position_detail || p.position,
      teamAbbrev: p.nhl_team,
      headshot: p.headshot_url || '',
    })));
  }

  if (pathname === '/api/standings/refresh' && request.method === 'POST') {
    clearNhlCache();
    return json({ success: true });
  }

  if (pathname === '/api/debug/player' && request.method === 'GET') {
    const url = new URL(request.url);
    const id = url.searchParams.get('id') || '8478402';
    const season = getCurrentSeason();
    try {
      const data = await fetch(`${NHL_BASE}/player/${id}/landing`, {
        headers: { 'User-Agent': 'PlayoffFantasy/1.0 (Cloudflare Worker)' }
      });
      const body = await data.json();
      const playoffEntry = getPlayoffStats(body, season);
      return json({ status: data.status, season, playoffEntry, seasonTotalsCount: (body.seasonTotals || []).length });
    } catch (e) {
      return json({ error: e.message, season });
    }
  }

  if (pathname === '/api/standings' && request.method === 'GET') {
    const season = getCurrentSeason();

    try {
      const teams = await getTeams(db);
      const teamsWithPlayers = await Promise.all(
        teams.map(async (team) => ({ ...team, players: await getTeamPlayers(db, team.id) }))
      );

      // Fetch all unique player landing pages in parallel
      const allPlayerIds = [...new Set(
        teamsWithPlayers.flatMap(t => t.players.map(p => p.player_id))
      )];
      const playerEntries = await Promise.all(
        allPlayerIds.map(async id => {
          try {
            const data = await cachedNhlFetch(`player-${id}`, `${NHL_BASE}/player/${id}/landing`);
            return [id, data];
          } catch {
            return [id, null];
          }
        })
      );
      const playerDataMap = Object.fromEntries(playerEntries);

      // Build normalized stat maps keyed by player_id
      const skaterMap = {};
      const goalieMap = {};
      for (const team of teamsWithPlayers) {
        for (const p of team.players) {
          if (p.player_id in skaterMap || p.player_id in goalieMap) continue;
          const entry = playerDataMap[p.player_id]
            ? getPlayoffStats(playerDataMap[p.player_id], season)
            : null;
          if (p.position === 'G') {
            goalieMap[p.player_id] = normalizeGoalie(entry, p.player_id);
          } else {
            skaterMap[p.player_id] = normalizeSkater(entry, p.player_id);
          }
        }
      }

      // Fetch GAA from dedicated playoff leaders endpoint — seasonTotals omits goalsAgainstAvg
      try {
        const gaaLeaders = await cachedNhlFetch(
          `goalie-gaa-${season}`,
          `${NHL_BASE}/goalie-stats-leaders/${season}/3?categories=goalsAgainstAvg&limit=500`
        );
        for (const g of (gaaLeaders?.goalsAgainstAvg || [])) {
          if (g.id != null && g.value != null && goalieMap[g.id] && goalieMap[g.id].goalsAgainstAverage == null) {
            goalieMap[g.id] = { ...goalieMap[g.id], goalsAgainstAverage: g.value };
          }
        }
      } catch {}

      const allGoalieIds = [
        ...new Set(
          teamsWithPlayers.flatMap((t) => t.players.filter((p) => p.position === 'G').map((p) => p.player_id))
        )
      ];
      // n is fixed to the total roster size so ranking points don't shift when
      // individual API calls fail or a goalie hasn't played yet this refresh.
      const n = allGoalieIds.length;

      // Update the confirmed-active registry with any new data, then build the
      // pool from it. This prevents a goalie from leaving the pool when a
      // transient NHL API response comes back without their playoff entry.
      for (const id of allGoalieIds) {
        const g = goalieMap[id];
        if (g && g.gamesPlayed > 0) confirmedActiveGoalies.set(id, g);
      }
      const poolGoalies = allGoalieIds
        .filter((id) => confirmedActiveGoalies.has(id))
        .map((id) => goalieMap[id] ?? confirmedActiveGoalies.get(id))
        .filter((g) => g);
      const sortedByGAA = [...poolGoalies].sort(
        (a, b) => (a.goalsAgainstAverage ?? 99) - (b.goalsAgainstAverage ?? 99)
      );
      const sortedBySVP = [...poolGoalies].sort((a, b) => (b.savePct ?? 0) - (a.savePct ?? 0));

      const gaaRankMap = Object.fromEntries(sortedByGAA.map((g, i) => [g.playerId, n - i]));
      const svpRankMap = Object.fromEntries(sortedBySVP.map((g, i) => [g.playerId, n - i]));

      const standings = teamsWithPlayers.map((team) => {
        let totalPoints = 0;

        const players = team.players.map((p) => {
          let points = 0;
          let breakdown = {};
          let stats = null;

          if (p.position === 'G') {
            stats = goalieMap[p.player_id] ?? null;
            if (stats) {
              const winsPoints = (stats.wins ?? 0) * 2;
              const shutoutPoints = (stats.shutouts ?? 0) * 3;
              const gaaRank = gaaRankMap[p.player_id] ?? 0;
              const svpRank = svpRankMap[p.player_id] ?? 0;
              points = winsPoints + shutoutPoints + gaaRank + svpRank;
              breakdown = { winsPoints, shutoutPoints, gaaRank, svpRank };
            }
          } else {
            stats = skaterMap[p.player_id] ?? null;
            if (stats) {
              const goalPoints = (stats.goals ?? 0) * 2;
              const assistPoints = stats.assists ?? 0;
              const stPoints =
                (stats.ppGoals ?? 0) +
                (stats.ppAssists ?? 0) +
                (stats.shGoals ?? 0) +
                (stats.shAssists ?? 0);
              const pimPoints = (stats.penaltyMinutes ?? 0) * 0.5;
              const pmPoints = stats.plusMinus ?? 0;
              points = goalPoints + assistPoints + stPoints + pimPoints + pmPoints;
              breakdown = { goalPoints, assistPoints, stPoints, pimPoints, pmPoints };
            }
          }

          totalPoints += points;
          return { ...p, stats, points: Math.round(points * 10) / 10, breakdown };
        });

        return { ...team, players, totalPoints: Math.round(totalPoints * 10) / 10 };
      });

      standings.sort((a, b) => b.totalPoints - a.totalPoints);
      const eliminatedTeams = await getEliminatedTeams(season);
      const fetchedCount = Object.values(playerDataMap).filter(Boolean).length;
      const withPlayoffData = Object.values(playerDataMap).filter(d => d && getPlayoffStats(d, season)).length;
      const result = { standings, season, poolGoalieCount: n, eliminatedTeams, lastUpdated: new Date().toISOString(), _debug: { totalPlayers: allPlayerIds.length, fetchedCount, withPlayoffData } };
      lastSuccessfulStandings = result;
      return json(result);
    } catch (e) {
      if (lastSuccessfulStandings) {
        return json({ ...lastSuccessfulStandings, stale: true, error: e.message });
      }
      const teams = await getTeams(db);
      const standings = await Promise.all(
        teams.map(async (t) => ({
          ...t,
          players: (await getTeamPlayers(db, t.id)).map((p) => ({
            ...p,
            stats: null,
            points: 0,
            breakdown: {}
          })),
          totalPoints: 0
        }))
      );

      return json({
        standings,
        season,
        poolGoalieCount: 0,
        lastUpdated: new Date().toISOString(),
        error: e.message
      });
    }
  }

  return json({ error: 'Not found' }, { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url.pathname);
    }

    return env.ASSETS.fetch(request);
  }
};
