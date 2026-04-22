const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

// Ensure data directory exists
if (!fs.existsSync('./data')) fs.mkdirSync('./data');

// Initialize SQLite
const db = new Database('./data/fantasy.db');
db.exec(`
  PRAGMA journal_mode=WAL;

  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    owner TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS team_players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    player_name TEXT NOT NULL,
    nhl_team TEXT DEFAULT '',
    position TEXT NOT NULL,
    position_detail TEXT DEFAULT '',
    headshot_url TEXT DEFAULT '',
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    UNIQUE(team_id, player_id)
  );
`);

// Simple in-memory cache (5 min TTL)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function cachedFetch(key, url) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < CACHE_TTL) return entry.data;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'PlayoffFantasy/1.0 (github.com/Zmalski/NHL-API-Reference)' }
    });
    if (!res.ok) throw new Error(`NHL API ${res.status}: ${url}`);
    const data = await res.json();
    cache.set(key, { data, time: Date.now() });
    return data;
  } catch (err) {
    // Return stale data rather than dropping the player to 0 points
    if (entry) return entry.data;
    throw err;
  }
}

function clearCache() {
  // Mark entries stale so fresh data is fetched, but keep values as fallback
  // in case the NHL API is temporarily unreachable.
  for (const [key, entry] of cache.entries()) {
    cache.set(key, { ...entry, time: 0 });
  }
}

function getCurrentSeason() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  // NHL season: playoffs happen in spring of the second year
  return month >= 10 ? `${year}${year + 1}` : `${year - 1}${year}`;
}

const NHL_BASE = 'https://api-web.nhle.com/v1';

function getPlayoffStats(data, season) {
  return (data.seasonTotals || []).find(
    s => s.leagueAbbrev === 'NHL' && s.gameTypeId === 3 && s.season === Number(season)
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

app.use(express.json());

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'client/dist')));
}

// ── Teams ──────────────────────────────────────────────────────────────────

app.get('/api/teams', (req, res) => {
  res.json(db.prepare('SELECT * FROM teams ORDER BY created_at DESC').all());
});

app.post('/api/teams', (req, res) => {
  const { name, owner } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Team name required' });
  try {
    const result = db.prepare('INSERT INTO teams (name, owner) VALUES (?, ?)').run(name.trim(), owner?.trim() || '');
    res.json({ id: result.lastInsertRowid, name: name.trim(), owner: owner?.trim() || '' });
  } catch {
    res.status(400).json({ error: 'A team with that name already exists' });
  }
});

app.put('/api/teams/:id', (req, res) => {
  const { name, owner } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Team name required' });
  try {
    db.prepare('UPDATE teams SET name = ?, owner = ? WHERE id = ?').run(name.trim(), owner?.trim() || '', req.params.id);
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: 'A team with that name already exists' });
  }
});

app.delete('/api/teams/:id', (req, res) => {
  db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Players ────────────────────────────────────────────────────────────────

app.get('/api/teams/:id/players', (req, res) => {
  res.json(db.prepare('SELECT * FROM team_players WHERE team_id = ?').all(req.params.id));
});

app.post('/api/teams/:id/players', (req, res) => {
  const { player_id, player_name, nhl_team, position, position_detail, headshot_url } = req.body;
  const team_id = parseInt(req.params.id);

  if (!player_id || !player_name || !position) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const players = db.prepare('SELECT * FROM team_players WHERE team_id = ?').all(team_id);
  const forwards = players.filter(p => p.position === 'F');
  const defensemen = players.filter(p => p.position === 'D');
  const goalies = players.filter(p => p.position === 'G');

  if (position === 'F' && forwards.length >= 10) {
    return res.status(400).json({ error: 'Maximum 10 forwards allowed per team' });
  }
  if (position === 'D' && defensemen.length >= 5) {
    return res.status(400).json({ error: 'Maximum 5 defensemen allowed per team' });
  }
  if (position === 'G' && goalies.length >= 3) {
    return res.status(400).json({ error: 'Maximum 3 goalies allowed per team' });
  }

  if (position === 'F') {
    const fromSameTeam = forwards.filter(p => p.nhl_team === nhl_team).length;
    if (fromSameTeam >= 3) {
      return res.status(400).json({ error: `Max 3 forwards from ${nhl_team} allowed` });
    }
  }
  if (position === 'D') {
    const fromSameTeam = defensemen.filter(p => p.nhl_team === nhl_team).length;
    if (fromSameTeam >= 2) {
      return res.status(400).json({ error: `Max 2 defensemen from ${nhl_team} allowed` });
    }
  }

  try {
    const result = db.prepare(
      'INSERT INTO team_players (team_id, player_id, player_name, nhl_team, position, position_detail, headshot_url) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(team_id, player_id, player_name, nhl_team || '', position, position_detail || '', headshot_url || '');
    res.json({ id: result.lastInsertRowid, team_id, player_id, player_name, nhl_team, position, position_detail, headshot_url });
  } catch {
    res.status(400).json({ error: 'Player is already on this team' });
  }
});

app.delete('/api/teams/:teamId/players/:id', (req, res) => {
  db.prepare('DELETE FROM team_players WHERE id = ? AND team_id = ?').run(req.params.id, req.params.teamId);
  res.json({ success: true });
});

// ── NHL API Proxy ──────────────────────────────────────────────────────────

app.get('/api/nhl/search', (req, res) => {
  const { q } = req.query;
  if (!q?.trim()) return res.json([]);
  const players = db.prepare(
    `SELECT DISTINCT player_id, player_name, nhl_team, position, position_detail, headshot_url
     FROM team_players WHERE player_name LIKE ? ORDER BY player_name LIMIT 20`
  ).all(`%${q.trim()}%`);
  res.json(players.map(p => ({
    playerId: p.player_id,
    name: p.player_name,
    positionCode: p.position_detail || p.position,
    teamAbbrev: p.nhl_team,
    headshot: p.headshot_url || '',
  })));
});

// ── Standings (calculates all fantasy points) ──────────────────────────────

app.post('/api/standings/refresh', (req, res) => {
  clearCache();
  res.json({ success: true });
});

app.get('/api/standings', async (req, res) => {
  const season = getCurrentSeason();
  try {
    const teams = db.prepare('SELECT * FROM teams').all();
    const teamsWithPlayers = teams.map(t => ({
      ...t,
      players: db.prepare('SELECT * FROM team_players WHERE team_id = ?').all(t.id)
    }));

    // Fetch all unique player landing pages in parallel
    const allPlayerIds = [...new Set(
      teamsWithPlayers.flatMap(t => t.players.map(p => p.player_id))
    )];
    const playerEntries = await Promise.all(
      allPlayerIds.map(async id => {
        try {
          const data = await cachedFetch(`player-${id}`, `${NHL_BASE}/player/${id}/landing`);
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
      const gaaLeaders = await cachedFetch(
        `goalie-gaa-${season}`,
        `${NHL_BASE}/goalie-stats-leaders/${season}/3?categories=goalsAgainstAvg&limit=500`
      );
      for (const g of (gaaLeaders?.goalsAgainstAvg || [])) {
        if (g.id != null && g.value != null && goalieMap[g.id] && goalieMap[g.id].goalsAgainstAverage == null) {
          goalieMap[g.id] = { ...goalieMap[g.id], goalsAgainstAverage: g.value };
        }
      }
    } catch {}

    // Pool all unique goalies from all fantasy teams for GAA/SV% ranking
    const allGoalieIds = [...new Set(
      teamsWithPlayers.flatMap(t => t.players.filter(p => p.position === 'G').map(p => p.player_id))
    )];
    // n is fixed to the total roster size so ranking points don't shift when
    // individual API calls fail or a goalie hasn't played yet this refresh.
    const n = allGoalieIds.length;
    const poolGoalies = allGoalieIds.map(id => goalieMap[id]).filter(g => g && g.gamesPlayed > 0);

    // Rank by GAA ascending (lower is better) and SV% descending (higher is better)
    const sortedByGAA = [...poolGoalies].sort((a, b) => (a.goalsAgainstAverage ?? 99) - (b.goalsAgainstAverage ?? 99));
    const sortedBySVP = [...poolGoalies].sort((a, b) => (b.savePct ?? 0) - (a.savePct ?? 0));

    const gaaRankMap = Object.fromEntries(sortedByGAA.map((g, i) => [g.playerId, n - i]));
    const svpRankMap = Object.fromEntries(sortedBySVP.map((g, i) => [g.playerId, n - i]));

    // Calculate fantasy points per team
    const standings = teamsWithPlayers.map(team => {
      let totalPoints = 0;

      const players = team.players.map(p => {
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
            const stPoints = (stats.ppGoals ?? 0) + (stats.ppAssists ?? 0) + (stats.shGoals ?? 0) + (stats.shAssists ?? 0);
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
    res.json({ standings, season, poolGoalieCount: n, lastUpdated: new Date().toISOString() });
  } catch (e) {
    console.error('Standings error:', e);
    // Return teams with 0 points if NHL API fails
    const teams = db.prepare('SELECT * FROM teams').all();
    const standings = teams.map(t => ({
      ...t,
      players: db.prepare('SELECT * FROM team_players WHERE team_id = ?').all(t.id).map(p => ({
        ...p, stats: null, points: 0, breakdown: {}
      })),
      totalPoints: 0
    }));
    res.json({ standings, season, poolGoalieCount: 0, lastUpdated: new Date().toISOString(), error: e.message });
  }
});

// Catch-all for React SPA in production
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'client/dist/index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`\n🏒 Playoff Fantasy server running on http://localhost:${PORT}`);
  console.log(`   Season: ${getCurrentSeason()} | Env: ${process.env.NODE_ENV || 'development'}\n`);
});
