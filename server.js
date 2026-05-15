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

  CREATE TABLE IF NOT EXISTS player_landing_snapshots (
    player_id INTEGER PRIMARY KEY,
    landing_json TEXT NOT NULL,
    headshot_url TEXT DEFAULT '',
    fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_player_landing_snapshots_fetched_at
    ON player_landing_snapshots (fetched_at);
`);

// Simple in-memory cache (5 min TTL)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// Last successfully computed standings — returned as stale fallback on failure
let lastSuccessfulStandings = null;

// Tracks goalies that have ever had gamesPlayed > 0. Once a goalie is confirmed
// active they stay in the ranking pool even if a transient NHL API response
// comes back without their playoff entry, preventing repeated rank shifts.
const confirmedActiveGoalies = new Map(); // playerId → last known normalized stats

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

async function getEliminatedTeams(season) {
  try {
    const data = await cachedFetch(`bracket-${season}`, `${NHL_BASE}/playoff-bracket/${season}`);
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

function getCurrentSeason() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  // NHL season: playoffs happen in spring of the second year
  return month >= 10 ? `${year}${year + 1}` : `${year - 1}${year}`;
}

const NHL_BASE = 'https://api-web.nhle.com/v1';

const DEFAULT_HEADSHOT_PATH_PARTS = [
  '/mugs/nhl/00head/',
];

function isDefaultHeadshotUrl(url) {
  if (!url) return true;
  return DEFAULT_HEADSHOT_PATH_PARTS.some((part) => String(url).includes(part));
}

function normalizeHeadshotUrl(url) {
  return isDefaultHeadshotUrl(url) ? '' : String(url);
}

function teamCrestUrl(abbrev) {
  if (!abbrev) return '';
  return `https://assets.nhle.com/logos/nhl/svg/${abbrev.toUpperCase()}_light.svg`;
}


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

function buildRankMap(goalies, accessor, direction = 'desc') {
  const sorted = [...goalies].sort((a, b) => {
    const aValue = accessor(a);
    const bValue = accessor(b);
    const diff = direction === 'asc' ? aValue - bValue : bValue - aValue;
    if (diff !== 0) return diff;
    // Keep ties deterministic so refreshes can't reshuffle points
    return a.playerId - b.playerId;
  });

  const n = sorted.length;
  const ranks = {};
  let pointsAtIndex = n;

  for (let i = 0; i < sorted.length; i++) {
    if (i > 0) {
      const prev = accessor(sorted[i - 1]);
      const current = accessor(sorted[i]);
      if (current !== prev) {
        pointsAtIndex = n - i;
      }
    }
    ranks[sorted[i].playerId] = pointsAtIndex;
  }

  return ranks;
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
  const players = db.prepare('SELECT * FROM team_players WHERE team_id = ?').all(req.params.id);
  res.json(players.map(p => ({
    ...p,
    headshot_url: normalizeHeadshotUrl(p.headshot_url),
  })));
});

app.post('/api/teams/:id/players', (req, res) => {
  const { player_id, player_name, nhl_team, position, position_detail, headshot_url } = req.body;
  const team_id = parseInt(req.params.id);
  const normalizedTeam = (nhl_team || '').trim().toUpperCase();

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
    const fromSameTeam = forwards.filter(p => (p.nhl_team || '').trim().toUpperCase() === normalizedTeam).length;
    if (fromSameTeam >= 3) {
      return res.status(400).json({ error: `Max 3 forwards from ${normalizedTeam} allowed` });
    }
  }
  if (position === 'D') {
    const fromSameTeam = defensemen.filter(p => (p.nhl_team || '').trim().toUpperCase() === normalizedTeam).length;
    if (fromSameTeam >= 2) {
      return res.status(400).json({ error: `Max 2 defensemen from ${normalizedTeam} allowed` });
    }
  }

  try {
    const result = db.prepare(
      'INSERT INTO team_players (team_id, player_id, player_name, nhl_team, position, position_detail, headshot_url, crest_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(team_id, player_id, player_name, normalizedTeam, position, position_detail || '', normalizeHeadshotUrl(headshot_url), teamCrestUrl(normalizedTeam));
    res.json({ id: result.lastInsertRowid, team_id, player_id, player_name, nhl_team: normalizedTeam, position, position_detail, headshot_url: normalizeHeadshotUrl(headshot_url), crest_url: teamCrestUrl(normalizedTeam) });
  } catch {
    res.status(400).json({ error: 'Player is already on this team' });
  }
});

app.delete('/api/teams/:teamId/players/:id', (req, res) => {
  db.prepare('DELETE FROM team_players WHERE id = ? AND team_id = ?').run(req.params.id, req.params.teamId);
  res.json({ success: true });
});

// ── NHL API Proxy ──────────────────────────────────────────────────────────

app.get('/api/nhl/search', async (req, res) => {
  const { q } = req.query;
  if (!q?.trim() || q.trim().length < 2) return res.json([]);
  try {
    const searchUrl = `https://search.d3.nhle.com/api/v1/search?q=${encodeURIComponent(q.trim())}&type=player&culture=en-us&limit=20`;
    const response = await fetch(searchUrl, {
      headers: { 'User-Agent': 'PlayoffFantasy/1.0 (github.com/Zmalski/NHL-API-Reference)' }
    });
    if (!response.ok) throw new Error(`NHL search ${response.status}`);
    const data = await response.json();
    return res.json((data || []).map(p => ({
      playerId: p.playerId,
      name: p.name,
      positionCode: p.positionCode || '',
      teamAbbrev: p.teamAbbrev || '',
      sweaterNumber: p.sweaterNumber || '',
      headshot: normalizeHeadshotUrl(p.headshot),
    })));
  } catch {
    // Fallback to DB search if NHL search API is unreachable
    const players = db.prepare(
      `SELECT DISTINCT player_id, player_name, nhl_team, position, position_detail, headshot_url
       FROM team_players WHERE player_name LIKE ? ORDER BY player_name LIMIT 20`
    ).all(`%${q.trim()}%`);
    return res.json(players.map(p => ({
      playerId: p.player_id,
      name: p.player_name,
      positionCode: p.position_detail || p.position,
      teamAbbrev: p.nhl_team,
      headshot: normalizeHeadshotUrl(p.headshot_url),
    })));
  }
});

// ── Player landing snapshot helpers (better-sqlite3 / synchronous) ────────

function getPlayerLandingSnapshotMap(playerIds) {
  if (!playerIds.length) return {};
  const placeholders = playerIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT player_id, landing_json, headshot_url, fetched_at
     FROM player_landing_snapshots
     WHERE player_id IN (${placeholders})`
  ).all(...playerIds);
  return Object.fromEntries(rows.map(row => [row.player_id, row]));
}

function savePlayerLandingSnapshot(playerId, landingData, fetchedAt) {
  const headshot = normalizeHeadshotUrl(landingData?.headshot);
  db.prepare(
    `INSERT INTO player_landing_snapshots (player_id, landing_json, headshot_url, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(player_id) DO UPDATE SET
       landing_json = excluded.landing_json,
       headshot_url = excluded.headshot_url,
       fetched_at = excluded.fetched_at`
  ).run(playerId, JSON.stringify(landingData), headshot || '', fetchedAt);
  if (headshot) {
    db.prepare('UPDATE team_players SET headshot_url = ? WHERE player_id = ?').run(headshot, playerId);
  }
  return headshot;
}

function parseLandingSnapshot(snapshot) {
  if (!snapshot?.landing_json) return null;
  try { return JSON.parse(snapshot.landing_json); } catch { return null; }
}

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
    const landingSnapshotMap = getPlayerLandingSnapshotMap(allPlayerIds);
    const playerEntries = await Promise.all(
      allPlayerIds.map(async id => {
        try {
          const data = await cachedFetch(`player-${id}`, `${NHL_BASE}/player/${id}/landing`);
          const headshot = savePlayerLandingSnapshot(id, data, new Date().toISOString());
          return [id, { data, headshot }];
        } catch {
          const storedLanding = parseLandingSnapshot(landingSnapshotMap[id]);
          return [id, {
            data: storedLanding,
            headshot: normalizeHeadshotUrl(landingSnapshotMap[id]?.headshot_url || storedLanding?.headshot)
          }];
        }
      })
    );
    const playerApiMap = Object.fromEntries(playerEntries);
    const playerDataMap = Object.fromEntries(
      allPlayerIds.map(id => [id, playerApiMap[id]?.data || null])
    );
    const playerHeadshotMap = Object.fromEntries(
      allPlayerIds.map(id => [id, normalizeHeadshotUrl(playerApiMap[id]?.headshot)])
    );

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

    // Update the confirmed-active registry with any new data, then build the
    // pool from it. This prevents a goalie from leaving the pool when a
    // transient NHL API response comes back without their playoff entry.
    for (const id of allGoalieIds) {
      const g = goalieMap[id];
      if (g && g.gamesPlayed > 0) confirmedActiveGoalies.set(id, g);
    }
    const poolGoalies = allGoalieIds
      .filter(id => confirmedActiveGoalies.has(id))
      .map(id => goalieMap[id] ?? confirmedActiveGoalies.get(id))
      .filter(g => g);

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
        const headshot_url = normalizeHeadshotUrl(p.headshot_url) || normalizeHeadshotUrl(playerDataMap[p.player_id]?.headshot);
        return { ...p, headshot_url, stats, points: Math.round(points * 10) / 10, breakdown };
      });

      return { ...team, players, totalPoints: Math.round(totalPoints * 10) / 10 };
    });

    standings.sort((a, b) => b.totalPoints - a.totalPoints);
    const eliminatedTeams = await getEliminatedTeams(season);
    const result = { standings, season, poolGoalieCount: n, eliminatedTeams, lastUpdated: new Date().toISOString() };
    lastSuccessfulStandings = result;
    res.json(result);
  } catch (e) {
    console.error('Standings error:', e);
    if (lastSuccessfulStandings) {
      return res.json({ ...lastSuccessfulStandings, stale: true, error: e.message });
    }
    // No prior successful result — return teams with 0 points
    const teams = db.prepare('SELECT * FROM teams').all();
    const standings = teams.map(t => ({
      ...t,
      players: db.prepare('SELECT * FROM team_players WHERE team_id = ?').all(t.id).map(p => ({
        ...p, headshot_url: normalizeHeadshotUrl(p.headshot_url), stats: null, points: 0, breakdown: {}
      })),
      totalPoints: 0
    }));
    res.json({ standings, season, poolGoalieCount: 0, lastUpdated: new Date().toISOString(), error: e.message });
  }
});

app.post('/api/admin/backfill-headshots', async (req, res) => {
  const players = db.prepare(
    'SELECT DISTINCT player_id, headshot_url FROM team_players'
  ).all();
  let updated = 0;
  let cleared = 0;
  await Promise.all(players.map(async ({ player_id, headshot_url }) => {
    try {
      const data = await fetch(`${NHL_BASE}/player/${player_id}/landing`, {
        headers: { 'User-Agent': 'PlayoffFantasy/1.0 (github.com/Zmalski/NHL-API-Reference)' }
      });
      if (!data.ok) return;
      const json = await data.json();
      const headshot = normalizeHeadshotUrl(json.headshot);
      if (!headshot) {
        if (headshot_url && isDefaultHeadshotUrl(headshot_url)) {
          db.prepare('UPDATE team_players SET headshot_url = ? WHERE player_id = ?')
            .run('', player_id);
          cleared++;
        }
        return;
      }
      db.prepare('UPDATE team_players SET headshot_url = ? WHERE player_id = ?')
        .run(headshot, player_id);
      updated++;
    } catch {}
  }));
  res.json({ success: true, updated, cleared });
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
