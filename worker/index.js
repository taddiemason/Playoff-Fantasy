const CACHE_TTL_MS = 5 * 60 * 1000;

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

async function cachedNhlFetch(cacheKey, url) {
  const cache = caches.default;
  const request = new Request(`https://cache.playofffantasy.internal/${cacheKey}`);

  const cached = await cache.match(request);
  if (cached) {
    const createdAt = Number(cached.headers.get('x-created-at') || 0);
    if (Date.now() - createdAt < CACHE_TTL_MS) {
      return cached.json();
    }
  }

  const res = await fetch(url, {
    headers: { 'User-Agent': 'PlayoffFantasy/1.0 (Cloudflare Worker)' }
  });

  if (!res.ok) {
    throw new Error(`NHL API ${res.status}: ${url}`);
  }

  const data = await res.json();
  const response = json(data, {
    headers: {
      'cache-control': 'public, max-age=300',
      'x-created-at': `${Date.now()}`
    }
  });

  await cache.put(request, response.clone());
  return data;
}

function clearNhlCache() {
  return;
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

    try {
      const data = await fetch(
        `https://search.d3.nhle.com/api/v1/search/player?culture=en-us&limit=20&q=${encodeURIComponent(q)}&active=true`,
        { headers: { 'User-Agent': 'PlayoffFantasy/1.0' } }
      ).then((r) => r.json());
      return json(data);
    } catch (e) {
      return json({ error: e.message }, { status: 500 });
    }
  }

  if (pathname === '/api/standings/refresh' && request.method === 'POST') {
    clearNhlCache();
    return json({ success: true });
  }

  if (pathname === '/api/standings' && request.method === 'GET') {
    const season = getCurrentSeason();

    try {
      const skaterExp = encodeURIComponent(`gameTypeId=3 and seasonId=${season}`);
      const goalieExp = encodeURIComponent(`gameTypeId=3 and seasonId=${season}`);

      const [skaterData, goalieData] = await Promise.all([
        cachedNhlFetch(
          `skaters-${season}`,
          `https://api.nhle.com/stats/rest/en/skater/summary?cayenneExp=${skaterExp}&sort=points&start=0&limit=500`
        ),
        cachedNhlFetch(
          `goalies-${season}`,
          `https://api.nhle.com/stats/rest/en/goalie/summary?cayenneExp=${goalieExp}&sort=wins&start=0&limit=200`
        )
      ]);

      const skaterStats = skaterData.data || [];
      const goalieStats = goalieData.data || [];
      const skaterMap = Object.fromEntries(skaterStats.map((s) => [s.playerId, s]));
      const goalieMap = Object.fromEntries(goalieStats.map((g) => [g.playerId, g]));

      const teams = await getTeams(db);
      const teamsWithPlayers = await Promise.all(
        teams.map(async (team) => ({ ...team, players: await getTeamPlayers(db, team.id) }))
      );

      const allGoalieIds = [
        ...new Set(
          teamsWithPlayers.flatMap((t) => t.players.filter((p) => p.position === 'G').map((p) => p.player_id))
        )
      ];
      const poolGoalies = allGoalieIds.map((id) => goalieMap[id]).filter((g) => g && g.gamesPlayed > 0);

      const n = poolGoalies.length;
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
      return json({ standings, season, poolGoalieCount: n, lastUpdated: new Date().toISOString() });
    } catch (e) {
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
