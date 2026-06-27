import {
  hashPassword,
  verifyPassword,
  createSession,
  getSessionUser,
  deleteSession,
  sessionCookie,
  clearCookie,
  parseCookies,
} from './auth.js';

export { DraftRoom } from './draft-room.js';
export { AuctionRoom } from './auction-room.js';
export { ChatRoom } from './chat-room.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const STATS_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const nhlCache = new Map(); // keyed by player-{id}, cleared on refresh (shared raw NHL data)

const NHL_TEAMS = ['ANA','BOS','BUF','CGY','CAR','CHI','COL','CBJ','DAL','DET','EDM','FLA','LAK','MIN','MTL','NSH','NJD','NYI','NYR','OTT','PHI','PIT','SJS','SEA','STL','TBL','TOR','UTA','VAN','VGK','WSH','WPG'];
let nhlRosterCache = null;
let nhlRosterCachedAt = 0;
const NHL_ROSTER_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getNhlRosterCache() {
  const now = Date.now();
  if (nhlRosterCache && (now - nhlRosterCachedAt) < NHL_ROSTER_TTL_MS) return nhlRosterCache;
  const season = getCurrentSeason();
  const rosters = await Promise.all(NHL_TEAMS.map(async (team) => {
    try {
      const res = await fetch(`${NHL_BASE}/roster/${team}/${season}`);
      if (!res.ok) return [];
      const data = await res.json();
      return [...(data.forwards || []), ...(data.defensemen || []), ...(data.goalies || [])].map(p => ({
        playerId: p.id,
        name: `${p.firstName?.default ?? ''} ${p.lastName?.default ?? ''}`.trim(),
        positionCode: p.positionCode || '',
        teamAbbrev: team,
        sweaterNumber: p.sweaterNumber || '',
        headshot: normalizeHeadshotUrl(p.headshot),
      }));
    } catch { return []; }
  }));
  nhlRosterCache = rosters.flat();
  nhlRosterCachedAt = now;
  return nhlRosterCache;
}

async function syncNhlRosters(db) {
  const season = getCurrentSeason();
  const now = new Date().toISOString();
  const players = await getNhlRosterCache();
  if (!players.length) return 0;
  // Upsert in batches of 100
  for (let i = 0; i < players.length; i += 100) {
    const batch = players.slice(i, i + 100);
    await db.batch(batch.map(p =>
      db.prepare(
        `INSERT INTO nhl_players (player_id, name, position_code, nhl_team, sweater_num, headshot_url, season, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET
           name = excluded.name, position_code = excluded.position_code,
           nhl_team = excluded.nhl_team, sweater_num = excluded.sweater_num,
           headshot_url = excluded.headshot_url, season = excluded.season,
           synced_at = excluded.synced_at`
      ).bind(p.playerId, p.name, p.positionCode, p.teamAbbrev, p.sweaterNumber || null,
             p.headshot || '', season, now)
    ));
  }
  return players.length;
}

async function syncInjuries(db) {
  const res = await fetch(`${NHL_BASE}/injury`, {
    headers: { 'User-Agent': 'PlayoffFantasy/1.0 (Cloudflare Worker)' }
  });
  if (!res.ok) throw new Error(`Injury endpoint returned ${res.status}`);
  const data = await res.json();
  const injured = Array.isArray(data) ? data : (data.injured || []);
  // Clear all injury columns — if fetch failed we threw above, so we never reach here on error
  await db.prepare(`UPDATE nhl_players SET injury_status = '', injury_description = ''`).run();
  // Write injured players in D1 batches of 100
  for (let i = 0; i < injured.length; i += 100) {
    const batch = injured.slice(i, i + 100);
    await db.batch(batch.map(p => {
      const playerId = p.playerId || p.id;
      const status = p.status || '';
      const description = p.injuryDescription || p.longTermInjuryNote || p.description || '';
      return db.prepare(
        `UPDATE nhl_players SET injury_status = ?, injury_description = ? WHERE player_id = ?`
      ).bind(status, description, playerId);
    }));
  }
  console.log(`[cron] syncInjuries: ${injured.length} injured players written`);
  return injured.length;
}

async function refreshRosteredPlayerLandings(db) {
  const { results } = await db
    .prepare('SELECT DISTINCT player_id FROM team_players')
    .all();
  const playerIds = (results || []).map(r => r.player_id);
  if (!playerIds.length) return;
  const now = new Date().toISOString();
  // Process in batches of 20 concurrent fetches
  for (let i = 0; i < playerIds.length; i += 20) {
    const batch = playerIds.slice(i, i + 20);
    await Promise.allSettled(batch.map(async (playerId) => {
      try {
        const res = await fetch(`${NHL_BASE}/player/${playerId}/landing`, {
          headers: { 'User-Agent': 'PlayoffFantasy/1.0 (Cloudflare Worker)' }
        });
        if (!res.ok) return;
        const data = await res.json();
        await savePlayerLandingSnapshot(db, playerId, data, now);
      } catch (err) {
        console.error(`[cron] landing refresh failed for player ${playerId}:`, err?.message);
      }
    }));
  }
  console.log(`[cron] refreshRosteredPlayerLandings: refreshed ${playerIds.length} players`);
}

// Standings state is keyed per league so leagues never clobber each other's
// goalie pools or cached results. The key is the league id (or '__global__'
// for the legacy single-pool standings endpoint).
const lastSuccessfulStandingsByLeague = new Map(); // cacheKey → last good result

// Tracks goalies that have ever had gamesPlayed > 0, per league. Once a goalie is
// confirmed active they stay in that league's ranking pool even if a transient
// NHL API response comes back without their playoff entry.
const confirmedActiveGoaliesByLeague = new Map(); // cacheKey → Map(playerId → stats)

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

function nextSeason(season) {
  const s = parseInt(season.slice(0, 4), 10);
  return `${s + 1}${s + 2}`;
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


function getSeasonStats(data, season, gameTypeId) {
  return (data.seasonTotals || []).find(
    s => s.leagueAbbrev === 'NHL' && s.gameTypeId === gameTypeId && String(s.season) === String(season)
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

async function getEliminatedTeams(season, db) {
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
    if (eliminated.size > 0) return [...eliminated];
  } catch {}

  // Fall back to manually set eliminated teams in DB
  try {
    const { results } = await db
      .prepare('SELECT abbrev FROM eliminated_teams WHERE season = ?')
      .bind(season)
      .all();
    return (results || []).map(r => r.abbrev);
  } catch {
    return [];
  }
}

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidUsername(username) {
  return !!username && username.length >= 3 && username.length <= 20 && /^[A-Za-z0-9_]+$/.test(username);
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    avatar_url: row.avatar_url || '',
    is_site_admin: !!row.is_site_admin,
  };
}

function validateCredentials(email, username, password) {
  if (!isValidEmail(email)) return 'Enter a valid email';
  if (!isValidUsername(username)) return 'Username must be 3–20 letters, numbers, or underscores';
  if (!password || password.length < 8) return 'Password must be at least 8 characters';
  return null;
}

function uniqueConflictMessage(err) {
  const msg = err?.message || '';
  if (!/UNIQUE/i.test(msg)) return null;
  return msg.includes('email') ? 'That email is already registered' : 'That username is taken';
}

function requireAuth(request, env) {
  const expected = env.ADMIN_PASSWORD
  if (!expected) return null
  const auth = request.headers.get('Authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (token !== expected) return json({ error: 'Unauthorized' }, { status: 401 })
  return null
}


function teamCrestUrl(abbrev) {
  if (!abbrev) return '';
  return `https://assets.nhle.com/logos/nhl/svg/${abbrev.toUpperCase()}_light.svg`;
}

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isFinite(id) ? id : null;
}

// ── League config ───────────────────────────────────────────────────────────
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
  auction_budget: 1000,
  bid_timer_seconds: 30,
  max_keepers: 3,
  keeper_cost_type: 'free',
  keeper_cost_inflation_pct: 20,
  taxi_squad_size: 3,
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
    pick_timer_seconds: parsed.pick_timer_seconds ?? d.pick_timer_seconds,
    auction_budget: parsed.auction_budget ?? d.auction_budget,
    bid_timer_seconds: parsed.bid_timer_seconds ?? d.bid_timer_seconds,
    max_keepers: parsed.max_keepers ?? d.max_keepers,
    keeper_cost_type: parsed.keeper_cost_type ?? d.keeper_cost_type,
    keeper_cost_inflation_pct: parsed.keeper_cost_inflation_pct ?? d.keeper_cost_inflation_pct,
    taxi_squad_size: parsed.taxi_squad_size ?? d.taxi_squad_size,
    lock: { ...d.lock, ...(parsed.lock) },
    payout: Array.isArray(parsed.payout) ? parsed.payout : d.payout,
    tiebreaker: { ...d.tiebreaker, ...(parsed.tiebreaker) },
  };
}

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateInviteCode(len = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join('');
}

function mapPosition(code) {
  const c = (code || '').toUpperCase();
  if (c === 'G') return 'G';
  if (c === 'D') return 'D';
  return 'F';
}

// Fantasy points for a player viewed outside the standings pipeline (Player
// Explorer search of a non-rostered player). Goalie rank points require the
// league's goalie pool, so they're omitted here and `partial` is flagged.
function scorePlayerStandalone(position, stats, cfg) {
  if (!stats) return { points: 0, breakdown: {}, partial: position === 'G' };
  if (position === 'G') {
    const winsPoints = (stats.wins ?? 0) * cfg.scoring.goalie.win;
    const shutoutPoints = (stats.shutouts ?? 0) * cfg.scoring.goalie.shutout;
    return {
      points: Math.round((winsPoints + shutoutPoints) * 10) / 10,
      breakdown: { winsPoints, shutoutPoints, gaaRank: null, svpRank: null },
      partial: true,
    };
  }
  const goalPoints = (stats.goals ?? 0) * cfg.scoring.skater.goal;
  const assistPoints = (stats.assists ?? 0) * cfg.scoring.skater.assist;
  const stPoints =
    ((stats.ppGoals ?? 0) + (stats.ppAssists ?? 0) + (stats.shGoals ?? 0) + (stats.shAssists ?? 0)) *
    cfg.scoring.skater.specialTeamsPointBonus;
  const pimPoints = (stats.penaltyMinutes ?? 0) * cfg.scoring.skater.pim;
  const pmPoints = stats.plusMinus ?? 0;
  return {
    points: Math.round((goalPoints + assistPoints + stPoints + pimPoints + pmPoints) * 10) / 10,
    breakdown: { goalPoints, assistPoints, stPoints, pimPoints, pmPoints },
    partial: false,
  };
}

// ── League access ───────────────────────────────────────────────────────────
async function getLeague(db, leagueId) {
  return db.prepare('SELECT * FROM leagues WHERE id = ?').bind(leagueId).first();
}

async function getMembershipRole(db, leagueId, userId) {
  if (!userId) return null;
  const row = await db
    .prepare('SELECT role FROM league_members WHERE league_id = ? AND user_id = ?')
    .bind(leagueId, userId)
    .first();
  return row ? row.role : null;
}

function isCommissioner(league, role, userId) {
  return role === 'commissioner' || (league && league.owner_user_id === userId);
}

function publicLeague(league, extra = {}) {
  return {
    id: league.id,
    name: league.name,
    owner_user_id: league.owner_user_id,
    season: league.season,
    season_type: league.season_type || 'playoffs',
    is_locked: !!league.is_locked,
    league_format: league.league_format || 'redraft',
    phase: league.phase || 'active',
    invite_code: league.invite_code,
    config: mergeConfig(league.config_json),
    created_at: league.created_at,
    ...extra,
  };
}

function inviteStatus(invite) {
  if (invite.revoked_at) return 'revoked';
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) return 'expired';
  if (invite.max_uses != null && invite.use_count >= invite.max_uses) return 'used up';
  return 'active';
}

// Resolves an invite code to its league. Accepts both an `invites` row code and a
// league's permanent `invite_code`. Returns { invite, league, active }.
async function resolveInviteCode(db, code) {
  const invite = await db.prepare('SELECT * FROM invites WHERE code = ?').bind(code).first();
  if (invite) {
    const league = await getLeague(db, invite.league_id);
    return { invite, league, active: inviteStatus(invite) === 'active' && !!league };
  }
  const league = await db.prepare('SELECT * FROM leagues WHERE invite_code = ?').bind(code).first();
  if (league) return { invite: null, league, active: true };
  return { invite: null, league: null, active: false };
}

// Resolves { user, league, role } for a league-scoped request, or { error } with
// a ready-to-return Response. Owners are always treated as commissioners.
async function loadLeagueContext(db, request, leagueId) {
  const league = await getLeague(db, leagueId);
  if (!league) return { error: json({ error: 'League not found' }, { status: 404 }) };
  const user = await getSessionUser(db, request);
  if (!user) return { error: json({ error: 'Unauthorized' }, { status: 401 }) };
  let role = await getMembershipRole(db, league.id, user.id);
  if (league.owner_user_id === user.id) role = 'commissioner';
  if (!role) return { error: json({ error: 'Not a member of this league' }, { status: 403 }) };
  return { user, league, role };
}

async function getTeams(db) {
  const { results } = await db.prepare('SELECT * FROM teams ORDER BY created_at DESC').all();
  return results || [];
}

async function getLeagueTeams(db, leagueId) {
  const { results } = await db
    .prepare('SELECT * FROM teams WHERE league_id = ? ORDER BY created_at DESC')
    .bind(leagueId)
    .all();
  return results || [];
}

async function getTeamPlayers(db, teamId) {
  const { results } = await db
    .prepare('SELECT * FROM team_players WHERE team_id = ? ORDER BY id DESC')
    .bind(teamId)
    .all();
  return (results || []).map(p => ({
    ...p,
    headshot_url: normalizeHeadshotUrl(p.headshot_url),
  }));
}

async function getPlayerSnapshotMap(db, season, gameType, playerIds) {
  if (!playerIds.length) return {};
  const placeholders = playerIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT player_id, stats_json, fetched_at
       FROM player_stats_snapshots
       WHERE season = ? AND game_type = ? AND player_id IN (${placeholders})`
    )
    .bind(season, gameType, ...playerIds)
    .all();

  return Object.fromEntries(
    (results || []).map((row) => [row.player_id, row])
  );
}


async function getPlayerLandingSnapshotMap(db, playerIds) {
  if (!playerIds.length) return {};
  const placeholders = playerIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT player_id, landing_json, headshot_url, fetched_at
       FROM player_landing_snapshots
       WHERE player_id IN (${placeholders})`
    )
    .bind(...playerIds)
    .all();

  return Object.fromEntries(
    (results || []).map((row) => [row.player_id, row])
  );
}

async function getInjuryMap(db, playerIds) {
  if (!playerIds || !playerIds.length) return {};
  const placeholders = playerIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT player_id, injury_status, injury_description
       FROM nhl_players WHERE player_id IN (${placeholders})`
    )
    .bind(...playerIds)
    .all();
  const map = {};
  for (const r of (results || [])) {
    map[r.player_id] = {
      injuryStatus: r.injury_status || '',
      injuryDescription: r.injury_description || '',
    };
  }
  return map;
}

async function savePlayerLandingSnapshot(db, playerId, landingData, fetchedAt) {
  const headshot = normalizeHeadshotUrl(landingData?.headshot);
  await db
    .prepare(
      `INSERT INTO player_landing_snapshots (player_id, landing_json, headshot_url, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         landing_json = excluded.landing_json,
         headshot_url = excluded.headshot_url,
         fetched_at = excluded.fetched_at`
    )
    .bind(playerId, JSON.stringify(landingData), headshot, fetchedAt)
    .run();
  if (headshot) {
    await db.prepare('UPDATE team_players SET headshot_url = ? WHERE player_id = ?')
      .bind(headshot, playerId)
      .run();
  }
  return headshot;
}

function parseLandingSnapshot(snapshot) {
  if (!snapshot?.landing_json) return null;
  try {
    return JSON.parse(snapshot.landing_json);
  } catch {
    return null;
  }
}

function isSnapshotFresh(fetchedAt, ttlMs = STATS_SNAPSHOT_TTL_MS) {
  if (!fetchedAt) return false;
  const ts = new Date(fetchedAt).getTime();
  return Number.isFinite(ts) && (Date.now() - ts) < ttlMs;
}

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

async function handleApi(request, env, pathname) {
  const db = env.DB;

  // ── Auth ──────────────────────────────────────────────────────────────────
  if (pathname === '/api/auth/register' && request.method === 'POST') {
    const { email, username, password } = await request.json();
    const e = normalizeEmail(email);
    const u = (username || '').trim();
    const vErr = validateCredentials(e, u, password);
    if (vErr) return json({ error: vErr }, { status: 400 });
    try {
      const hash = await hashPassword(password);
      const row = await db
        .prepare(
          `INSERT INTO users (email, username, password_hash) VALUES (?, ?, ?)
           RETURNING id, email, username, avatar_url, is_site_admin`
        )
        .bind(e, u, hash)
        .first();
      const token = await createSession(db, row.id);
      return json({ user: publicUser(row) }, { headers: { 'Set-Cookie': sessionCookie(token, request) } });
    } catch (err) {
      const conflict = uniqueConflictMessage(err);
      if (conflict) return json({ error: conflict }, { status: 400 });
      return json({ error: 'Failed to create account' }, { status: 500 });
    }
  }

  if (pathname === '/api/auth/login' && request.method === 'POST') {
    const { identifier, password } = await request.json();
    const id = (identifier || '').trim();
    if (!id || !password) return json({ error: 'Enter your login and password' }, { status: 400 });
    const row = await db
      .prepare(
        `SELECT id, email, username, avatar_url, is_site_admin, password_hash
         FROM users WHERE email = ? OR username = ?`
      )
      .bind(id.toLowerCase(), id)
      .first();
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      return json({ error: 'Invalid login or password' }, { status: 401 });
    }
    const token = await createSession(db, row.id);
    return json({ user: publicUser(row) }, { headers: { 'Set-Cookie': sessionCookie(token, request) } });
  }

  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    await deleteSession(db, request);
    return json({ success: true }, { headers: { 'Set-Cookie': clearCookie(request) } });
  }

  if (pathname === '/api/auth/me' && request.method === 'GET') {
    const user = await getSessionUser(db, request);
    return json({ user });
  }

  // Admin-issued reset (no email provider yet). Site admin sets a user's password.
  if (pathname === '/api/auth/reset-password' && request.method === 'POST') {
    const actor = await getSessionUser(db, request);
    if (!actor?.is_site_admin) return json({ error: 'Unauthorized' }, { status: 401 });
    const { email, newPassword } = await request.json();
    if (!newPassword || newPassword.length < 8) {
      return json({ error: 'New password must be at least 8 characters' }, { status: 400 });
    }
    const target = await db.prepare('SELECT id FROM users WHERE email = ?').bind(normalizeEmail(email)).first();
    if (!target) return json({ error: 'No user with that email' }, { status: 404 });
    const hash = await hashPassword(newPassword);
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, target.id).run();
    await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id).run();
    return json({ success: true });
  }

  // ── Current user (profile/settings) ────────────────────────────────────────
  if (pathname === '/api/me' && request.method === 'PATCH') {
    const user = await getSessionUser(db, request);
    if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
    const body = await request.json();
    const fields = [];
    const values = [];
    if (body.username !== undefined) {
      const u = (body.username || '').trim();
      if (!isValidUsername(u)) return json({ error: 'Username must be 3–20 letters, numbers, or underscores' }, { status: 400 });
      fields.push('username = ?'); values.push(u);
    }
    if (body.email !== undefined) {
      const e = normalizeEmail(body.email);
      if (!isValidEmail(e)) return json({ error: 'Enter a valid email' }, { status: 400 });
      fields.push('email = ?'); values.push(e);
    }
    if (body.avatar_url !== undefined) {
      fields.push('avatar_url = ?'); values.push((body.avatar_url || '').trim());
    }
    if (!fields.length) return json({ error: 'Nothing to update' }, { status: 400 });
    try {
      const row = await db
        .prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ? RETURNING id, email, username, avatar_url, is_site_admin`)
        .bind(...values, user.id)
        .first();
      return json({ user: publicUser(row) });
    } catch (err) {
      const conflict = uniqueConflictMessage(err);
      if (conflict) return json({ error: conflict }, { status: 400 });
      return json({ error: 'Failed to update profile' }, { status: 500 });
    }
  }

  if (pathname === '/api/me/password' && request.method === 'POST') {
    const user = await getSessionUser(db, request);
    if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
    const { currentPassword, newPassword } = await request.json();
    if (!newPassword || newPassword.length < 8) {
      return json({ error: 'New password must be at least 8 characters' }, { status: 400 });
    }
    const row = await db.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first();
    if (!row || !(await verifyPassword(currentPassword || '', row.password_hash))) {
      return json({ error: 'Current password is incorrect' }, { status: 400 });
    }
    const hash = await hashPassword(newPassword);
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, user.id).run();
    // Invalidate other sessions, keep the current one alive.
    const currentToken = parseCookies(request).sid || '';
    await db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(user.id, currentToken).run();
    return json({ success: true });
  }

  // ── Site admin bootstrap ────────────────────────────────────────────────────
  // Guarded by ADMIN_PASSWORD (the only secret that exists pre-accounts).
  // Idempotent: creates/promotes the admin user and migrates any orphaned teams
  // (the pre-accounts pool) into a single league the admin owns.
  if (pathname === '/api/admin/bootstrap' && request.method === 'POST') {
    const authErr = requireAuth(request, env); if (authErr) return authErr;
    const body = await request.json();
    const e = normalizeEmail(body.email);
    const u = (body.username || '').trim();

    let user = await db
      .prepare('SELECT id, email, username, avatar_url, is_site_admin FROM users WHERE email = ?')
      .bind(e)
      .first();
    if (!user) {
      const vErr = validateCredentials(e, u, body.password);
      if (vErr) return json({ error: vErr }, { status: 400 });
      try {
        const hash = await hashPassword(body.password);
        user = await db
          .prepare(
            `INSERT INTO users (email, username, password_hash, is_site_admin) VALUES (?, ?, ?, 1)
             RETURNING id, email, username, avatar_url, is_site_admin`
          )
          .bind(e, u, hash)
          .first();
      } catch (err) {
        const conflict = uniqueConflictMessage(err);
        if (conflict) return json({ error: conflict }, { status: 400 });
        return json({ error: 'Bootstrap failed' }, { status: 500 });
      }
    } else if (!user.is_site_admin) {
      await db.prepare('UPDATE users SET is_site_admin = 1 WHERE id = ?').bind(user.id).run();
      user.is_site_admin = 1;
    }

    const orphan = await db.prepare('SELECT COUNT(*) AS c FROM teams WHERE league_id IS NULL').first();
    let migratedLeague = null;
    if ((orphan?.c ?? 0) > 0) {
      const league = await db
        .prepare(
          `INSERT INTO leagues (name, owner_user_id, season, config_json, invite_code)
           VALUES (?, ?, ?, ?, ?) RETURNING *`
        )
        .bind('SHLOB Playoff Hockey', user.id, getCurrentSeason(), JSON.stringify(DEFAULT_LEAGUE_CONFIG), generateInviteCode())
        .first();
      await db.prepare('INSERT OR IGNORE INTO league_members (league_id, user_id, role) VALUES (?, ?, ?)')
        .bind(league.id, user.id, 'commissioner').run();
      await db.prepare('UPDATE teams SET league_id = ?, user_id = ? WHERE league_id IS NULL')
        .bind(league.id, user.id).run();
      migratedLeague = publicLeague(league, { migratedTeams: orphan.c });
    }

    return json({ user: publicUser(user), migratedLeague });
  }

  // ── Leagues ─────────────────────────────────────────────────────────────────
  if (pathname === '/api/me/leagues' && request.method === 'GET') {
    const user = await getSessionUser(db, request);
    if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
    const { results } = await db
      .prepare(
        `SELECT l.*, lm.role AS my_role,
                (SELECT COUNT(*) FROM league_members m WHERE m.league_id = l.id) AS member_count,
                (SELECT COUNT(*) FROM teams t WHERE t.league_id = l.id) AS team_count
         FROM league_members lm JOIN leagues l ON l.id = lm.league_id
         WHERE lm.user_id = ?
         ORDER BY l.created_at DESC`
      )
      .bind(user.id)
      .all();
    const leagues = (results || []).map((l) =>
      publicLeague(l, {
        role: l.my_role,
        memberCount: l.member_count,
        teamCount: l.team_count,
        isOwner: l.owner_user_id === user.id,
      })
    );
    const { results: pend } = await db
      .prepare(
        `SELECT i.code, i.league_id, l.name AS league_name
         FROM invites i JOIN leagues l ON l.id = i.league_id
         WHERE i.email = ? AND i.revoked_at IS NULL
           AND (i.expires_at IS NULL OR i.expires_at > ?)
           AND (i.max_uses IS NULL OR i.use_count < i.max_uses)
           AND NOT EXISTS (SELECT 1 FROM league_members m WHERE m.league_id = i.league_id AND m.user_id = ?)
         ORDER BY i.created_at DESC`
      )
      .bind(user.email, new Date().toISOString(), user.id)
      .all();
    const invites = (pend || []).map((r) => ({ code: r.code, leagueId: r.league_id, leagueName: r.league_name }));

    return json({
      owned: leagues.filter((l) => l.isOwner),
      joined: leagues.filter((l) => !l.isOwner),
      invites,
    });
  }

  if (pathname === '/api/leagues' && request.method === 'POST') {
    const user = await getSessionUser(db, request);
    if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
    const { name, season_type } = await request.json();
    if (!name?.trim()) return json({ error: 'League name required' }, { status: 400 });
    const seasonType = (season_type === 'regular') ? 'regular' : 'playoffs';
    const league = await db
      .prepare(
        `INSERT INTO leagues (name, owner_user_id, season, season_type, config_json, invite_code, phase)
         VALUES (?, ?, ?, ?, ?, ?, 'pre_draft') RETURNING *`
      )
      .bind(name.trim(), user.id, getCurrentSeason(), seasonType, JSON.stringify(DEFAULT_LEAGUE_CONFIG), generateInviteCode())
      .first();
    await db.prepare('INSERT INTO league_members (league_id, user_id, role) VALUES (?, ?, ?)')
      .bind(league.id, user.id, 'commissioner').run();
    return json(publicLeague(league, { role: 'commissioner', memberCount: 1, teamCount: 0, isOwner: true }));
  }

  const leagueMatch = pathname.match(/^\/api\/leagues\/(\d+)$/);
  if (leagueMatch && request.method === 'GET') {
    const leagueId = parseId(leagueMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    const mc = await db.prepare('SELECT COUNT(*) AS c FROM league_members WHERE league_id = ?').bind(leagueId).first();
    return json(publicLeague(ctx.league, {
      role: ctx.role,
      isOwner: ctx.league.owner_user_id === ctx.user.id,
      memberCount: mc?.c ?? 0,
    }));
  }

  if (leagueMatch && request.method === 'PATCH') {
    const leagueId = parseId(leagueMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id)) return json({ error: 'Commissioner only' }, { status: 403 });
    const body = await request.json();
    const fields = [];
    const values = [];
    if (body.name !== undefined) {
      if (!body.name.trim()) return json({ error: 'League name required' }, { status: 400 });
      fields.push('name = ?'); values.push(body.name.trim());
    }
    if (body.config !== undefined) {
      const merged = mergeConfig({ ...mergeConfig(ctx.league.config_json), ...body.config });
      fields.push('config_json = ?'); values.push(JSON.stringify(merged));
    }
    if (body.is_locked !== undefined) {
      fields.push('is_locked = ?'); values.push(body.is_locked ? 1 : 0);
    }
    if (body.league_format !== undefined) {
      if (!['redraft', 'keeper', 'dynasty'].includes(body.league_format))
        return json({ error: 'Invalid league_format' }, { status: 400 });
      fields.push('league_format = ?'); values.push(body.league_format);
    }
    if (!fields.length) return json({ error: 'Nothing to update' }, { status: 400 });
    const league = await db.prepare(`UPDATE leagues SET ${fields.join(', ')} WHERE id = ? RETURNING *`).bind(...values, leagueId).first();
    return json(publicLeague(league, { role: ctx.role, isOwner: league.owner_user_id === ctx.user.id }));
  }

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

    const lineupTeam = await db.prepare('SELECT id FROM teams WHERE id = ? AND league_id = ?')
      .bind(teamId, leagueId).first();
    if (!lineupTeam) return json({ error: 'Team not found in this league' }, { status: 404 });

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
    const injuryMap = await getInjuryMap(db, players.map(p => p.player_id));
    const addInjury = p => ({
      ...p,
      injuryStatus: injuryMap[p.player_id]?.injuryStatus || '',
      injuryDescription: injuryMap[p.player_id]?.injuryDescription || '',
    });
    return json({ active: active.map(addInjury), bench: bench.map(addInjury), slots, locked });
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

  // ── Season lifecycle ────────────────────────────────────────────────────────

  // POST /api/leagues/:id/season/end
  if (request.method === 'POST' && pathname.match(/^\/api\/leagues\/\d+\/season\/end$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id))
      return json({ error: 'Commissioner only' }, { status: 403 });
    if (ctx.league.phase !== 'active')
      return json({ error: `Cannot end season in phase: ${ctx.league.phase}` }, { status: 400 });

    const { results: allPlayers } = await db.prepare(
      `SELECT tp.team_id, tp.player_id, tp.player_name, tp.position, tp.nhl_team,
              tp.headshot_url, tp.crest_url
       FROM team_players tp
       JOIN teams t ON t.id = tp.team_id
       WHERE t.league_id = ?`
    ).bind(leagueId).all();

    const now = new Date().toISOString();
    if (allPlayers && allPlayers.length > 0) {
      const snapshots = allPlayers.map(p =>
        db.prepare(
          `INSERT OR IGNORE INTO roster_snapshots
             (league_id, team_id, player_id, player_name, player_meta_json, season, was_keeper, snapshotted_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
        ).bind(leagueId, p.team_id, p.player_id, p.player_name,
               JSON.stringify({ position: p.position || '', nhl_team: p.nhl_team || '',
                                headshot_url: p.headshot_url || '', crest_url: p.crest_url || '' }),
               ctx.league.season, now)
      );
      for (let i = 0; i < snapshots.length; i += 100) {
        await db.batch(snapshots.slice(i, i + 100));
      }
    }

    await db.prepare("UPDATE leagues SET phase = 'offseason' WHERE id = ?").bind(leagueId).run();
    return json({ ok: true });
  }

  // POST /api/leagues/:id/season/keeper-window/open
  if (request.method === 'POST' && pathname.match(/^\/api\/leagues\/\d+\/season\/keeper-window\/open$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id))
      return json({ error: 'Commissioner only' }, { status: 403 });
    if (ctx.league.league_format !== 'keeper')
      return json({ error: 'Only keeper-format leagues have a keeper window' }, { status: 400 });
    if (ctx.league.phase !== 'offseason')
      return json({ error: `Cannot open keeper window in phase: ${ctx.league.phase}` }, { status: 400 });
    await db.prepare("UPDATE leagues SET phase = 'keeper_window' WHERE id = ?").bind(leagueId).run();
    return json({ ok: true });
  }

  // POST /api/leagues/:id/season/keeper-window/close
  if (request.method === 'POST' && pathname.match(/^\/api\/leagues\/\d+\/season\/keeper-window\/close$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id))
      return json({ error: 'Commissioner only' }, { status: 403 });
    if (ctx.league.phase !== 'keeper_window')
      return json({ error: `Cannot close keeper window in phase: ${ctx.league.phase}` }, { status: 400 });

    const currentSeason = ctx.league.season;
    // Mark designated keepers in roster_snapshots
    const { results: kd } = await db.prepare(
      'SELECT team_id, player_id, cost_type, cost_value FROM keeper_designations WHERE league_id = ? AND season = ?'
    ).bind(leagueId, currentSeason).all();

    if (kd && kd.length > 0) {
      const updateSnaps = kd.map(k =>
        db.prepare(
          `UPDATE roster_snapshots SET was_keeper = 1, keeper_cost_type = ?, keeper_cost_value = ?
           WHERE league_id = ? AND team_id = ? AND player_id = ? AND season = ?`
        ).bind(k.cost_type, k.cost_value, leagueId, k.team_id, k.player_id, currentSeason)
      );
      for (let i = 0; i < updateSnaps.length; i += 100) {
        await db.batch(updateSnaps.slice(i, i + 100));
      }
    }

    // Delete non-keeper players from team_players
    const keeperSet = new Set((kd || []).map(k => `${k.team_id}-${k.player_id}`));
    const { results: allTp } = await db.prepare(
      `SELECT tp.id, tp.team_id, tp.player_id FROM team_players tp
       JOIN teams t ON t.id = tp.team_id WHERE t.league_id = ?`
    ).bind(leagueId).all();
    const toDelete = (allTp || []).filter(p => !keeperSet.has(`${p.team_id}-${p.player_id}`));
    if (toDelete.length > 0) {
      const delStmts = toDelete.map(p => db.prepare('DELETE FROM team_players WHERE id = ?').bind(p.id));
      for (let i = 0; i < delStmts.length; i += 100) {
        await db.batch(delStmts.slice(i, i + 100));
      }
    }

    const ns = nextSeason(currentSeason);
    await db.prepare("UPDATE leagues SET phase = 'pre_draft', season = ? WHERE id = ?").bind(ns, leagueId).run();
    return json({ ok: true, nextSeason: ns });
  }

  // POST /api/leagues/:id/season/start
  if (request.method === 'POST' && pathname.match(/^\/api\/leagues\/\d+\/season\/start$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id))
      return json({ error: 'Commissioner only' }, { status: 403 });
    if (ctx.league.league_format === 'keeper')
      return json({ error: 'Keeper leagues use the keeper window flow' }, { status: 400 });
    if (ctx.league.phase !== 'offseason')
      return json({ error: `Cannot start new season in phase: ${ctx.league.phase}` }, { status: 400 });
    const ns = nextSeason(ctx.league.season);
    const newPhase = ctx.league.league_format === 'dynasty' ? 'supplemental_draft' : 'pre_draft';
    await db.prepare('UPDATE leagues SET phase = ?, season = ? WHERE id = ?').bind(newPhase, ns, leagueId).run();
    return json({ ok: true, nextSeason: ns, phase: newPhase });
  }

  // POST /api/leagues/:id/season/activate
  if (request.method === 'POST' && pathname.match(/^\/api\/leagues\/\d+\/season\/activate$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id))
      return json({ error: 'Commissioner only' }, { status: 403 });
    if (ctx.league.phase !== 'pre_draft')
      return json({ error: `Cannot activate season in phase: ${ctx.league.phase}` }, { status: 400 });

    if (ctx.league.league_format === 'dynasty') {
      const config = mergeConfig(ctx.league.config_json);
      const maxRoster = config.roster.maxF + config.roster.maxD + config.roster.maxG;
      const { results: overLimit } = await db.prepare(
        `SELECT t.id, t.name,
                COUNT(CASE WHEN tp.is_taxi_squad = 0 THEN 1 END) AS main_count,
                COUNT(CASE WHEN tp.is_taxi_squad = 1 THEN 1 END) AS taxi_count
         FROM teams t
         LEFT JOIN team_players tp ON tp.team_id = t.id
         WHERE t.league_id = ?
         GROUP BY t.id
         HAVING main_count > ? OR taxi_count > ?`
      ).bind(leagueId, maxRoster, config.taxi_squad_size).all();
      if (overLimit && overLimit.length > 0) {
        return json({
          error: 'Cannot activate: some teams are over their roster or taxi squad limit',
          teams: overLimit,
        }, { status: 400 });
      }
    }

    await db.prepare("UPDATE leagues SET phase = 'active' WHERE id = ?").bind(leagueId).run();
    return json({ ok: true });
  }

  // GET /api/leagues/:id/keepers
  if (request.method === 'GET' && pathname.match(/^\/api\/leagues\/\d+\/keepers$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    const config = mergeConfig(ctx.league.config_json);

    // All designations for current season
    const { results: designations } = await db.prepare(
      'SELECT * FROM keeper_designations WHERE league_id = ? AND season = ? ORDER BY team_id, player_name'
    ).bind(leagueId, ctx.league.season).all();

    // My team
    const myTeam = await db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id = ?')
      .bind(leagueId, ctx.user.id).first();

    // My roster with cost_value pre-calculated
    let myRoster = [];
    if (myTeam) {
      const { results: players } = await db.prepare(
        `SELECT tp.player_id, tp.player_name, tp.position, tp.nhl_team, tp.headshot_url, tp.crest_url
         FROM team_players tp WHERE tp.team_id = ?`
      ).bind(myTeam.id).all();

      myRoster = await Promise.all((players || []).map(async (p) => {
        let costValue = 0;
        if (config.keeper_cost_type === 'pick_round') {
          const row = await db.prepare(
            `SELECT dp.round FROM draft_picks dp
             JOIN draft_sessions ds ON ds.id = dp.draft_session_id
             WHERE ds.league_id = ? AND dp.player_id = ?
             ORDER BY dp.picked_at DESC LIMIT 1`
          ).bind(leagueId, p.player_id).first();
          costValue = row?.round ?? 0;
        } else if (config.keeper_cost_type === 'auction_inflation') {
          const row = await db.prepare(
            `SELECT ap.amount FROM auction_picks ap
             JOIN auction_sessions asess ON asess.id = ap.auction_session_id
             WHERE asess.league_id = ? AND ap.player_id = ?
             ORDER BY ap.picked_at DESC LIMIT 1`
          ).bind(leagueId, p.player_id).first();
          const base = row?.amount ?? 0;
          costValue = Math.round(base * (1 + config.keeper_cost_inflation_pct / 100));
        }
        return { ...p, costValue };
      }));
    }

    // All teams' designation counts (for commissioner readiness)
    const { results: allTeams } = await db.prepare('SELECT id, name FROM teams WHERE league_id = ? ORDER BY name').bind(leagueId).all();
    const countMap = {};
    for (const d of (designations || [])) {
      countMap[d.team_id] = (countMap[d.team_id] || 0) + 1;
    }
    const teams = (allTeams || []).map(t => ({ ...t, designationCount: countMap[t.id] || 0 }));

    return json({
      designations: designations || [],
      config: {
        maxKeepers: config.max_keepers,
        keeperCostType: config.keeper_cost_type,
        keeperCostInflationPct: config.keeper_cost_inflation_pct,
      },
      myTeamId: myTeam?.id ?? null,
      myRoster,
      teams,
    });
  }

  // PUT /api/leagues/:id/keepers
  if (request.method === 'PUT' && pathname.match(/^\/api\/leagues\/\d+\/keepers$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (ctx.league.phase !== 'keeper_window')
      return json({ error: 'Keeper window is not open' }, { status: 400 });

    const myTeam = await db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id = ?')
      .bind(leagueId, ctx.user.id).first();
    if (!myTeam) return json({ error: 'You do not have a team in this league' }, { status: 403 });

    const config = mergeConfig(ctx.league.config_json);
    const body = await request.json();
    const keepers = Array.isArray(body.keepers) ? body.keepers : [];

    if (keepers.length > config.max_keepers)
      return json({ error: `Maximum ${config.max_keepers} keepers allowed` }, { status: 400 });

    const now = new Date().toISOString();
    const currentSeason = ctx.league.season;

    // Calculate cost for each keeper
    const upserts = await Promise.all(keepers.map(async (k) => {
      let costValue = 0;
      const costType = config.keeper_cost_type;
      if (costType === 'pick_round') {
        const row = await db.prepare(
          `SELECT dp.round FROM draft_picks dp
           JOIN draft_sessions ds ON ds.id = dp.draft_session_id
           WHERE ds.league_id = ? AND dp.player_id = ?
           ORDER BY dp.picked_at DESC LIMIT 1`
        ).bind(leagueId, k.playerId).first();
        costValue = row?.round ?? 0;
      } else if (costType === 'auction_inflation') {
        const row = await db.prepare(
          `SELECT ap.amount FROM auction_picks ap
           JOIN auction_sessions asess ON asess.id = ap.auction_session_id
           WHERE asess.league_id = ? AND ap.player_id = ?
           ORDER BY ap.picked_at DESC LIMIT 1`
        ).bind(leagueId, k.playerId).first();
        const base = row?.amount ?? 0;
        costValue = Math.round(base * (1 + config.keeper_cost_inflation_pct / 100));
      }
      const meta = JSON.stringify(k.playerMeta || {});
      return db.prepare(
        `INSERT INTO keeper_designations
           (league_id, team_id, player_id, player_name, player_meta_json, cost_type, cost_value, season, designated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(league_id, team_id, player_id, season) DO UPDATE SET
           player_name = excluded.player_name,
           player_meta_json = excluded.player_meta_json,
           cost_type = excluded.cost_type,
           cost_value = excluded.cost_value,
           designated_at = excluded.designated_at`
      ).bind(leagueId, myTeam.id, k.playerId, k.playerName, meta, costType, costValue, currentSeason, now);
    }));

    // Delete designations not in new list
    const keepingIds = keepers.map(k => k.playerId);
    const { results: existing } = await db.prepare(
      'SELECT player_id FROM keeper_designations WHERE league_id = ? AND team_id = ? AND season = ?'
    ).bind(leagueId, myTeam.id, currentSeason).all();
    const toRemove = (existing || []).filter(e => !keepingIds.includes(e.player_id));
    const deleteStmts = toRemove.map(e =>
      db.prepare('DELETE FROM keeper_designations WHERE league_id = ? AND team_id = ? AND player_id = ? AND season = ?')
        .bind(leagueId, myTeam.id, e.player_id, currentSeason)
    );

    const allStmts = [...upserts, ...deleteStmts];
    for (let i = 0; i < allStmts.length; i += 100) {
      await db.batch(allStmts.slice(i, i + 100));
    }

    const { results: designations } = await db.prepare(
      'SELECT * FROM keeper_designations WHERE league_id = ? AND team_id = ? AND season = ?'
    ).bind(leagueId, myTeam.id, currentSeason).all();
    return json({ ok: true, designations: designations || [] });
  }

  // DELETE /api/leagues/:id/keepers/:playerId
  if (request.method === 'DELETE' && pathname.match(/^\/api\/leagues\/\d+\/keepers\/\d+$/)) {
    const parts = pathname.split('/');
    const leagueId = parseId(parts[3]);
    const playerId = parseId(parts[5]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (ctx.league.phase !== 'keeper_window')
      return json({ error: 'Keeper window is not open' }, { status: 400 });
    const myTeam = await db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id = ?')
      .bind(leagueId, ctx.user.id).first();
    if (!myTeam) return json({ error: 'No team found' }, { status: 403 });
    await db.prepare(
      'DELETE FROM keeper_designations WHERE league_id = ? AND team_id = ? AND player_id = ? AND season = ?'
    ).bind(leagueId, myTeam.id, playerId, ctx.league.season).run();
    return json({ ok: true });
  }

  // PUT /api/leagues/:id/taxi
  if (request.method === 'PUT' && pathname.match(/^\/api\/leagues\/\d+\/taxi$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (ctx.league.league_format !== 'dynasty')
      return json({ error: 'Taxi squad is only available in dynasty leagues' }, { status: 400 });
    const myTeam = await db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id = ?')
      .bind(leagueId, ctx.user.id).first();
    if (!myTeam) return json({ error: 'No team found' }, { status: 403 });
    const body = await request.json();
    const { player_id, is_taxi_squad } = body;
    if (typeof player_id !== 'number' || typeof is_taxi_squad !== 'boolean')
      return json({ error: 'player_id (number) and is_taxi_squad (boolean) required' }, { status: 400 });

    if (is_taxi_squad) {
      const config = mergeConfig(ctx.league.config_json);
      const taxiCount = await db.prepare(
        'SELECT COUNT(*) AS c FROM team_players WHERE team_id = ? AND is_taxi_squad = 1'
      ).bind(myTeam.id).first();
      if ((taxiCount?.c ?? 0) >= config.taxi_squad_size)
        return json({ error: `Taxi squad is full (max ${config.taxi_squad_size})` }, { status: 400 });
    }

    await db.prepare(
      'UPDATE team_players SET is_taxi_squad = ? WHERE team_id = ? AND player_id = ?'
    ).bind(is_taxi_squad ? 1 : 0, myTeam.id, player_id).run();
    return json({ ok: true });
  }

  // GET /api/leagues/:id/roster-snapshots
  if (request.method === 'GET' && pathname.match(/^\/api\/leagues\/\d+\/roster-snapshots$/)) {
    const leagueId = parseId(pathname.split('/')[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    const { results } = await db.prepare(
      `SELECT rs.*, t.name AS team_name
       FROM roster_snapshots rs
       JOIN teams t ON t.id = rs.team_id
       WHERE rs.league_id = ?
       ORDER BY rs.season DESC, rs.team_id, rs.player_name`
    ).bind(leagueId).all();
    return json({ snapshots: results || [] });
  }

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

  // ── Auction ───────────────────────────────────────────────────────────────

  // POST /api/leagues/:id/auction/session — create or reset pending session
  if (request.method === 'POST' && pathname.match(/^\/api\/leagues\/\d+\/auction\/session$/)) {
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
  if (request.method === 'GET' && pathname.match(/^\/api\/leagues\/\d+\/auction\/session$/)) {
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
  if (request.method === 'PUT' && pathname.match(/^\/api\/leagues\/\d+\/auction\/session\/order$/)) {
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
  if (request.method === 'POST' && pathname.match(/^\/api\/leagues\/\d+\/auction\/session\/randomize$/)) {
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
  if (request.method === 'POST' && pathname.match(/^\/api\/leagues\/\d+\/auction\/session\/start$/)) {
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

  // GET /api/leagues/:id/chat/messages — load last 50 messages (HTTP, for initial load)
  const chatMsgsMatch = pathname.match(/^\/api\/leagues\/(\d+)\/chat\/messages$/);
  if (chatMsgsMatch && request.method === 'GET') {
    const leagueId = parseId(chatMsgsMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    const limit = Math.min(parseInt(new URL(request.url).searchParams.get('limit') || '50'), 50);
    const { results: msgs } = await db.prepare(
      `SELECT * FROM chat_messages WHERE league_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`
    ).bind(leagueId, limit).all();
    if (!msgs || !msgs.length) return json([]);
    const ids = msgs.map(m => m.id);
    const ph = ids.map(() => '?').join(',');
    const { results: reactions } = await db.prepare(
      `SELECT message_id, emoji, user_id FROM chat_reactions WHERE message_id IN (${ph})`
    ).bind(...ids).all();
    const reactionsByMsg = {};
    for (const r of (reactions || [])) {
      if (!reactionsByMsg[r.message_id]) reactionsByMsg[r.message_id] = {};
      if (!reactionsByMsg[r.message_id][r.emoji]) reactionsByMsg[r.message_id][r.emoji] = [];
      reactionsByMsg[r.message_id][r.emoji].push(r.user_id);
    }
    return json(msgs.reverse().map(m => ({
      id: m.id,
      userId: m.user_id,
      username: m.username,
      body: m.body,
      pinned: !!m.pinned,
      pinnedAt: m.pinned_at || null,
      createdAt: m.created_at,
      reactions: Object.entries(reactionsByMsg[m.id] || {}).map(([emoji, userIds]) => ({
        emoji, count: userIds.length, reactorIds: userIds,
      })),
    })));
  }

  // GET /api/leagues/:id/chat/ws — WebSocket upgrade to ChatRoom DO
  const chatWsMatch = pathname.match(/^\/api\/leagues\/(\d+)\/chat\/ws$/);
  if (chatWsMatch && request.method === 'GET') {
    const leagueId = parseId(chatWsMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;

    const doId = env.CHAT_ROOM.idFromName(`league-${leagueId}`);
    const stub = env.CHAT_ROOM.get(doId);

    const proxiedReq = new Request(request.url, {
      method: request.method,
      headers: new Headers({
        ...Object.fromEntries(request.headers),
        'X-League-Id': String(leagueId),
        'X-User-Id': String(ctx.user.id),
        'X-Username': ctx.user.username || 'Unknown',
        'X-Is-Commissioner': String(isCommissioner(ctx.league, ctx.role, ctx.user.id)),
      }),
    });

    return stub.fetch(proxiedReq);
  }

  // GET /api/leagues/:id/auction/ws — WebSocket proxy
  if (request.method === 'GET' && pathname.match(/^\/api\/leagues\/\d+\/auction\/ws$/)) {
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
  if (request.method === 'POST' && pathname.match(/^\/api\/leagues\/\d+\/auction\/session\/pause$/)) {
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
  if (request.method === 'POST' && pathname.match(/^\/api\/leagues\/\d+\/auction\/session\/resume$/)) {
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
    if (ctx.league.is_locked) return json({ error: 'League is locked' }, { status: 403 });

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
      SELECT dp.*, t.name AS dropped_by_team_name,
             COALESCE(np.injury_status, '') AS injury_status,
             COALESCE(np.injury_description, '') AS injury_description
      FROM dropped_players dp
      JOIN teams t ON t.id = dp.dropped_by_team_id
      LEFT JOIN nhl_players np ON np.player_id = dp.player_id
      WHERE dp.league_id = ? AND dp.status IN ('waivers', 'free_agent')
      ORDER BY dp.dropped_at DESC
    `).bind(leagueId).all();

    const myTeam = await db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id = ?')
      .bind(leagueId, ctx.user.id).first();

    const myClaims = myTeam
      ? (await db.prepare(`SELECT * FROM waiver_claims WHERE team_id = ? AND status = 'pending'`)
          .bind(myTeam.id).all()).results || []
      : [];

    const mappedPlayers = (players || []).map(({ injury_status, injury_description, ...rest }) => ({
      ...rest,
      injuryStatus: injury_status || '',
      injuryDescription: injury_description || '',
    }));
    return json({ players: mappedPlayers, myClaims });
  }

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
    if (ctx.league.is_locked) return json({ error: 'League is locked' }, { status: 403 });

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
    if (ctx.league.is_locked) return json({ error: 'League is locked' }, { status: 403 });

    const dp = await db.prepare('SELECT * FROM dropped_players WHERE id = ? AND league_id = ?')
      .bind(droppedPlayerId, leagueId).first();
    if (!dp) return json({ error: 'Player not found' }, { status: 404 });
    if (dp.status !== 'free_agent') return json({ error: 'Player is not a free agent' }, { status: 400 });

    const meta = JSON.parse(dp.player_meta_json || '{}');

    const config = mergeConfig(ctx.league.config_json);
    const pos = meta.position || '';
    const capKey = pos === 'G' ? 'maxG' : pos === 'D' ? 'maxD' : 'maxF';
    const { results: roster } = await db.prepare(
      `SELECT id FROM team_players WHERE team_id = ? AND position = ?`
    ).bind(team.id, pos).all();
    if ((roster || []).length >= (config.roster[capKey] ?? 99)) {
      return json({ error: `Roster full for position ${pos}` }, { status: 400 });
    }

    try {
      await db.batch([
        db.prepare(`UPDATE dropped_players SET status = 'claimed' WHERE id = ?`).bind(droppedPlayerId),
        db.prepare(`INSERT INTO team_players
          (team_id, player_id, player_name, nhl_team, position, position_detail, headshot_url, crest_url)
          VALUES (?, ?, ?, ?, ?, '', ?, ?)`)
          .bind(team.id, dp.player_id, dp.player_name, meta.nhl_team || '', meta.position || '',
                meta.headshot_url || '', meta.crest_url || ''),
      ]);
    } catch {
      return json({ error: 'Player is already on your team' }, { status: 400 });
    }

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
    if (ctx.league.is_locked) return json({ error: 'League is locked' }, { status: 403 });
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

  // League-scoped teams
  const lgTeamsMatch = pathname.match(/^\/api\/leagues\/(\d+)\/teams$/);
  if (lgTeamsMatch && request.method === 'GET') {
    const leagueId = parseId(lgTeamsMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    return json(await getLeagueTeams(db, leagueId));
  }

  if (lgTeamsMatch && request.method === 'POST') {
    const leagueId = parseId(lgTeamsMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (ctx.league.is_locked && !isCommissioner(ctx.league, ctx.role, ctx.user.id)) {
      return json({ error: 'League is locked' }, { status: 403 });
    }
    const { name, owner, tiebreaker } = await request.json();
    if (!name?.trim()) return json({ error: 'Team name required' }, { status: 400 });
    try {
      const team = await db
        .prepare(`INSERT INTO teams (league_id, user_id, name, owner, tiebreaker) VALUES (?, ?, ?, ?, ?) RETURNING *`)
        .bind(leagueId, ctx.user.id, name.trim(), owner?.trim() || '', tiebreaker?.trim() || null)
        .first();
      return json(team);
    } catch (err) {
      if (/UNIQUE/i.test(err?.message || '')) return json({ error: 'A team with that name already exists in this league' }, { status: 400 });
      return json({ error: 'Failed to create team' }, { status: 500 });
    }
  }

  const lgTeamMatch = pathname.match(/^\/api\/leagues\/(\d+)\/teams\/(\d+)$/);
  if (lgTeamMatch && (request.method === 'PUT' || request.method === 'DELETE')) {
    const leagueId = parseId(lgTeamMatch[1]);
    const teamId = parseId(lgTeamMatch[2]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    const team = await db.prepare('SELECT * FROM teams WHERE id = ? AND league_id = ?').bind(teamId, leagueId).first();
    if (!team) return json({ error: 'Team not found' }, { status: 404 });
    const canModify = team.user_id === ctx.user.id || isCommissioner(ctx.league, ctx.role, ctx.user.id);
    if (!canModify) return json({ error: 'You can only edit your own team' }, { status: 403 });

    if (request.method === 'DELETE') {
      await db.prepare('DELETE FROM teams WHERE id = ?').bind(teamId).run();
      return json({ success: true });
    }
    const { name, owner, tiebreaker } = await request.json();
    if (!name?.trim()) return json({ error: 'Team name required' }, { status: 400 });
    try {
      await db.prepare('UPDATE teams SET name = ?, owner = ?, tiebreaker = ? WHERE id = ?')
        .bind(name.trim(), owner?.trim() || '', tiebreaker?.trim() || null, teamId).run();
      return json({ success: true });
    } catch (err) {
      if (/UNIQUE/i.test(err?.message || '')) return json({ error: 'A team with that name already exists in this league' }, { status: 400 });
      return json({ error: 'Failed to update team' }, { status: 500 });
    }
  }

  // League-scoped players
  const lgPlayersMatch = pathname.match(/^\/api\/leagues\/(\d+)\/teams\/(\d+)\/players$/);
  if (lgPlayersMatch && request.method === 'GET') {
    const leagueId = parseId(lgPlayersMatch[1]);
    const teamId = parseId(lgPlayersMatch[2]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    const players = await getTeamPlayers(db, teamId);
    const injuryMap = await getInjuryMap(db, players.map(p => p.player_id));
    return json(players.map(p => ({
      ...p,
      injuryStatus: injuryMap[p.player_id]?.injuryStatus || '',
      injuryDescription: injuryMap[p.player_id]?.injuryDescription || '',
    })));
  }

  if (lgPlayersMatch && request.method === 'POST') {
    const leagueId = parseId(lgPlayersMatch[1]);
    const teamId = parseId(lgPlayersMatch[2]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    const team = await db.prepare('SELECT * FROM teams WHERE id = ? AND league_id = ?').bind(teamId, leagueId).first();
    if (!team) return json({ error: 'Team not found' }, { status: 404 });
    const canModify = team.user_id === ctx.user.id || isCommissioner(ctx.league, ctx.role, ctx.user.id);
    if (!canModify) return json({ error: 'You can only edit your own team' }, { status: 403 });
    if (ctx.league.is_locked && !isCommissioner(ctx.league, ctx.role, ctx.user.id)) {
      return json({ error: 'League is locked' }, { status: 403 });
    }
    const { player_id, player_name, nhl_team, position, position_detail, headshot_url } = await request.json();
    if (!player_id || !player_name || !position) return json({ error: 'Missing required fields' }, { status: 400 });

    const caps = mergeConfig(ctx.league.config_json).roster;
    const players = await getTeamPlayers(db, teamId);
    const forwards = players.filter((p) => p.position === 'F');
    const defensemen = players.filter((p) => p.position === 'D');
    const goalies = players.filter((p) => p.position === 'G');
    if (position === 'F' && forwards.length >= caps.maxF) return json({ error: `Maximum ${caps.maxF} forwards allowed per team` }, { status: 400 });
    if (position === 'D' && defensemen.length >= caps.maxD) return json({ error: `Maximum ${caps.maxD} defensemen allowed per team` }, { status: 400 });
    if (position === 'G' && goalies.length >= caps.maxG) return json({ error: `Maximum ${caps.maxG} goalies allowed per team` }, { status: 400 });
    if (position === 'F' && forwards.filter((p) => p.nhl_team === nhl_team).length >= caps.maxSameTeamF) {
      return json({ error: `Max ${caps.maxSameTeamF} forwards from ${nhl_team} allowed` }, { status: 400 });
    }
    if (position === 'D' && defensemen.filter((p) => p.nhl_team === nhl_team).length >= caps.maxSameTeamD) {
      return json({ error: `Max ${caps.maxSameTeamD} defensemen from ${nhl_team} allowed` }, { status: 400 });
    }
    try {
      const result = await db
        .prepare(`INSERT INTO team_players
          (team_id, player_id, player_name, nhl_team, position, position_detail, headshot_url, crest_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
        .bind(teamId, player_id, player_name, nhl_team || '', position, position_detail || '', normalizeHeadshotUrl(headshot_url), teamCrestUrl(nhl_team))
        .first();
      return json(result);
    } catch {
      return json({ error: 'Player is already on this team' }, { status: 400 });
    }
  }

  const lgRemovePlayerMatch = pathname.match(/^\/api\/leagues\/(\d+)\/teams\/(\d+)\/players\/(\d+)$/);
  if (lgRemovePlayerMatch && request.method === 'DELETE') {
    const leagueId = parseId(lgRemovePlayerMatch[1]);
    const teamId = parseId(lgRemovePlayerMatch[2]);
    const rowId = parseId(lgRemovePlayerMatch[3]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    const team = await db.prepare('SELECT * FROM teams WHERE id = ? AND league_id = ?').bind(teamId, leagueId).first();
    if (!team) return json({ error: 'Team not found' }, { status: 404 });
    const canModify = team.user_id === ctx.user.id || isCommissioner(ctx.league, ctx.role, ctx.user.id);
    if (!canModify) return json({ error: 'You can only edit your own team' }, { status: 403 });
    if (ctx.league.is_locked && !isCommissioner(ctx.league, ctx.role, ctx.user.id)) {
      return json({ error: 'League is locked' }, { status: 403 });
    }
    await db.prepare('DELETE FROM team_players WHERE id = ? AND team_id = ?').bind(rowId, teamId).run();
    return json({ success: true });
  }

  // League-scoped standings
  const lgStandingsMatch = pathname.match(/^\/api\/leagues\/(\d+)\/standings$/);
  if (lgStandingsMatch && request.method === 'GET') {
    const leagueId = parseId(lgStandingsMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    const result = await computeStandings(db, { leagueId, season: ctx.league.season, seasonType: ctx.league.season_type || 'playoffs', config: mergeConfig(ctx.league.config_json) });
    return json(result);
  }

  const lgRefreshMatch = pathname.match(/^\/api\/leagues\/(\d+)\/standings\/refresh$/);
  if (lgRefreshMatch && request.method === 'POST') {
    const leagueId = parseId(lgRefreshMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    clearNhlCache();
    return json({ success: true });
  }

  // ── Commissioner: members ───────────────────────────────────────────────────
  const lgMembersMatch = pathname.match(/^\/api\/leagues\/(\d+)\/members$/);
  if (lgMembersMatch && request.method === 'GET') {
    const leagueId = parseId(lgMembersMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id)) return json({ error: 'Commissioner only' }, { status: 403 });
    const { results } = await db
      .prepare(
        `SELECT lm.user_id, lm.role, u.username, u.email, u.avatar_url,
                (SELECT COUNT(*) FROM teams t WHERE t.league_id = lm.league_id AND t.user_id = lm.user_id) AS team_count
         FROM league_members lm JOIN users u ON u.id = lm.user_id
         WHERE lm.league_id = ?
         ORDER BY lm.role DESC, u.username`
      )
      .bind(leagueId)
      .all();
    const members = (results || []).map((m) => ({
      user_id: m.user_id,
      username: m.username,
      email: m.email,
      avatar_url: m.avatar_url || '',
      role: m.role,
      teamCount: m.team_count,
      isOwner: m.user_id === ctx.league.owner_user_id,
    }));
    return json(members);
  }

  const lgMemberMatch = pathname.match(/^\/api\/leagues\/(\d+)\/members\/(\d+)$/);
  if (lgMemberMatch && request.method === 'DELETE') {
    const leagueId = parseId(lgMemberMatch[1]);
    const targetUserId = parseId(lgMemberMatch[2]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id)) return json({ error: 'Commissioner only' }, { status: 403 });
    if (targetUserId === ctx.league.owner_user_id) return json({ error: 'Cannot remove the league owner' }, { status: 400 });
    await db.prepare('DELETE FROM teams WHERE league_id = ? AND user_id = ?').bind(leagueId, targetUserId).run();
    await db.prepare('DELETE FROM league_members WHERE league_id = ? AND user_id = ?').bind(leagueId, targetUserId).run();
    return json({ success: true });
  }

  // ── Commissioner: invites ───────────────────────────────────────────────────
  const lgInvitesMatch = pathname.match(/^\/api\/leagues\/(\d+)\/invites$/);
  if (lgInvitesMatch && request.method === 'GET') {
    const leagueId = parseId(lgInvitesMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id)) return json({ error: 'Commissioner only' }, { status: 403 });
    const { results } = await db.prepare('SELECT * FROM invites WHERE league_id = ? ORDER BY created_at DESC').bind(leagueId).all();
    const invites = (results || []).map((i) => ({
      id: i.id, code: i.code, email: i.email, max_uses: i.max_uses, use_count: i.use_count,
      expires_at: i.expires_at, created_at: i.created_at, status: inviteStatus(i),
    }));
    return json({ invites, leagueCode: ctx.league.invite_code });
  }

  if (lgInvitesMatch && request.method === 'POST') {
    const leagueId = parseId(lgInvitesMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id)) return json({ error: 'Commissioner only' }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    const maxUses = Number.isFinite(body.maxUses) && body.maxUses > 0 ? Math.floor(body.maxUses) : null;
    const email = body.email ? normalizeEmail(body.email) : null;
    let expiresAt = null;
    if (Number.isFinite(body.expiresInDays) && body.expiresInDays > 0) {
      expiresAt = new Date(Date.now() + body.expiresInDays * 86400000).toISOString();
    }
    const invite = await db
      .prepare(
        `INSERT INTO invites (league_id, code, created_by, email, max_uses, expires_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
      )
      .bind(leagueId, generateInviteCode(), ctx.user.id, email, maxUses, expiresAt)
      .first();
    return json({ id: invite.id, code: invite.code, email: invite.email, max_uses: invite.max_uses, use_count: invite.use_count, expires_at: invite.expires_at, created_at: invite.created_at, status: inviteStatus(invite) });
  }

  const lgInviteMatch = pathname.match(/^\/api\/leagues\/(\d+)\/invites\/(\d+)$/);
  if (lgInviteMatch && request.method === 'DELETE') {
    const leagueId = parseId(lgInviteMatch[1]);
    const inviteId = parseId(lgInviteMatch[2]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    if (!isCommissioner(ctx.league, ctx.role, ctx.user.id)) return json({ error: 'Commissioner only' }, { status: 403 });
    await db.prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND league_id = ?')
      .bind(new Date().toISOString(), inviteId, leagueId).run();
    return json({ success: true });
  }

  // ── Invites: public preview + join ──────────────────────────────────────────
  const invitePreviewMatch = pathname.match(/^\/api\/invites\/([A-Za-z0-9]+)$/);
  if (invitePreviewMatch && request.method === 'GET') {
    const code = invitePreviewMatch[1];
    const { league, active } = await resolveInviteCode(db, code);
    if (!league) return json({ valid: false, error: 'Invite not found' }, { status: 404 });
    const mc = await db.prepare('SELECT COUNT(*) AS c FROM league_members WHERE league_id = ?').bind(league.id).first();
    const user = await getSessionUser(db, request);
    const alreadyMember = user ? !!(await getMembershipRole(db, league.id, user.id)) || league.owner_user_id === user.id : false;
    return json({
      valid: active,
      error: active ? null : 'This invite is no longer valid',
      league: { id: league.id, name: league.name, memberCount: mc?.c ?? 0 },
      alreadyMember,
      loggedIn: !!user,
    });
  }

  const inviteJoinMatch = pathname.match(/^\/api\/invites\/([A-Za-z0-9]+)\/join$/);
  if (inviteJoinMatch && request.method === 'POST') {
    const code = inviteJoinMatch[1];
    const user = await getSessionUser(db, request);
    if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
    const { invite, league, active } = await resolveInviteCode(db, code);
    if (!league) return json({ error: 'Invite not found' }, { status: 404 });

    const existing = await getMembershipRole(db, league.id, user.id);
    if (existing || league.owner_user_id === user.id) {
      return json({ league: { id: league.id, name: league.name }, alreadyMember: true });
    }
    if (!active) return json({ error: 'This invite is no longer valid' }, { status: 400 });

    await db.prepare('INSERT OR IGNORE INTO league_members (league_id, user_id, role) VALUES (?, ?, ?)')
      .bind(league.id, user.id, 'member').run();
    if (invite) {
      await db.prepare('UPDATE invites SET use_count = use_count + 1 WHERE id = ?').bind(invite.id).run();
    }
    return json({ league: { id: league.id, name: league.name }, alreadyMember: false });
  }

  // ── League Injuries ──────────────────────────────────────────────────────────
  const leagueInjuriesMatch = pathname.match(/^\/api\/leagues\/(\d+)\/injuries$/);
  if (leagueInjuriesMatch && request.method === 'GET') {
    const leagueId = parseId(leagueInjuriesMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    const { results } = await db
      .prepare(`SELECT player_id, injury_status, injury_description FROM nhl_players WHERE injury_status != ''`)
      .all();
    const injuries = {};
    for (const r of (results || [])) {
      injuries[r.player_id] = {
        injuryStatus: r.injury_status,
        injuryDescription: r.injury_description,
      };
    }
    return json({ injuries });
  }

  // ── Player Explorer ─────────────────────────────────────────────────────────
  const explorerMatch = pathname.match(/^\/api\/leagues\/(\d+)\/players$/);
  if (explorerMatch && request.method === 'GET') {
    const leagueId = parseId(explorerMatch[1]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    const cfg = mergeConfig(ctx.league.config_json);
    const standings = await computeStandings(db, { leagueId, season: ctx.league.season, seasonType: ctx.league.season_type || 'playoffs', config: cfg });
    const totalTeams = standings.standings.length;
    const elimSet = new Set((standings.eliminatedTeams || []).map((t) => (t || '').trim().toUpperCase()));
    const map = new Map();
    for (const team of standings.standings) {
      for (const p of team.players) {
        let e = map.get(p.player_id);
        if (!e) {
          e = {
            playerId: p.player_id, name: p.player_name, position: p.position,
            position_detail: p.position_detail, nhl_team: p.nhl_team, headshot_url: p.headshot_url,
            crest_url: p.crest_url, stats: p.stats, points: p.points, breakdown: p.breakdown,
            owners: [], eliminated: elimSet.has((p.nhl_team || '').trim().toUpperCase()),
          };
          map.set(p.player_id, e);
        }
        e.owners.push({ teamId: team.id, teamName: team.name, owner: team.owner });
      }
    }
    const playerIdList = [...map.keys()];
    const injuryMap = await getInjuryMap(db, playerIdList);
    const players = [...map.values()]
      .map((p) => ({
        ...p,
        ownerCount: p.owners.length,
        ownershipPct: totalTeams ? Math.round((p.owners.length / totalTeams) * 100) : 0,
        injuryStatus: injuryMap[p.playerId]?.injuryStatus || '',
        injuryDescription: injuryMap[p.playerId]?.injuryDescription || '',
      }))
      .sort((a, b) => (b.points || 0) - (a.points || 0));
    return json({ players, totalTeams, season: standings.season });
  }

  const playerDetailMatch = pathname.match(/^\/api\/leagues\/(\d+)\/players\/(\d+)$/);
  if (playerDetailMatch && request.method === 'GET') {
    const leagueId = parseId(playerDetailMatch[1]);
    const playerId = parseId(playerDetailMatch[2]);
    const ctx = await loadLeagueContext(db, request, leagueId);
    if (ctx.error) return ctx.error;
    const cfg = mergeConfig(ctx.league.config_json);
    const season = ctx.league.season;
    const seasonType = ctx.league.season_type || 'playoffs';
    const gameTypeId = seasonType === 'regular' ? 2 : 3;
    const standings = await computeStandings(db, { leagueId, season, seasonType, config: cfg });
    const totalTeams = standings.standings.length;
    const elimSet = new Set((standings.eliminatedTeams || []).map((t) => (t || '').trim().toUpperCase()));

    const owners = [];
    let rostered = null;
    for (const team of standings.standings) {
      for (const p of team.players) {
        if (p.player_id === playerId) {
          owners.push({ teamId: team.id, teamName: team.name, owner: team.owner });
          if (!rostered) rostered = p;
        }
      }
    }

    let player, stats, points, breakdown, partial = false;
    if (rostered) {
      player = {
        playerId, name: rostered.player_name, position: rostered.position,
        position_detail: rostered.position_detail, nhl_team: rostered.nhl_team,
        headshot_url: rostered.headshot_url, crest_url: rostered.crest_url,
      };
      stats = rostered.stats; points = rostered.points; breakdown = rostered.breakdown;
    } else {
      try {
        const data = await cachedNhlFetch(`player-${playerId}`, `${NHL_BASE}/player/${playerId}/landing`);
        const pos = mapPosition(data.position);
        stats = pos === 'G' ? normalizeGoalie(getSeasonStats(data, season, gameTypeId), playerId) : normalizeSkater(getSeasonStats(data, season, gameTypeId), playerId);
        const scored = scorePlayerStandalone(pos, stats, cfg);
        points = scored.points; breakdown = scored.breakdown; partial = scored.partial;
        player = {
          playerId,
          name: `${data.firstName?.default || ''} ${data.lastName?.default || ''}`.trim(),
          position: pos, position_detail: data.position || '',
          nhl_team: data.currentTeamAbbrev || '',
          headshot_url: normalizeHeadshotUrl(data.headshot),
          crest_url: teamCrestUrl(data.currentTeamAbbrev),
        };
      } catch {
        return json({ error: 'Could not load player' }, { status: 502 });
      }
    }

    const eliminated = elimSet.has((player.nhl_team || '').trim().toUpperCase());

    // Fetch injury + landing data in parallel
    const [nhlRow, landingSnap] = await Promise.all([
      db.prepare('SELECT injury_status, injury_description FROM nhl_players WHERE player_id = ?')
        .bind(playerId).first(),
      db.prepare('SELECT landing_json FROM player_landing_snapshots WHERE player_id = ?')
        .bind(playerId).first(),
    ]);
    const injuryStatus = nhlRow?.injury_status || '';
    const injuryDescription = nhlRow?.injury_description || '';

    let featuredStats = null, gameLog = null, spotlightStories = null;
    if (landingSnap?.landing_json) {
      try {
        const landing = JSON.parse(landingSnap.landing_json);
        featuredStats = landing.featuredStats || null;
        gameLog = (landing.gameLog || []).slice(0, 5);
        spotlightStories = landing.spotlightStories || null;
      } catch {}
    }

    return json({
      player: { ...player, injuryStatus, injuryDescription },
      stats, points, breakdown, partial,
      owners, ownerCount: owners.length,
      ownershipPct: totalTeams ? Math.round((owners.length / totalTeams) * 100) : 0,
      totalTeams, eliminated, season,
      injuryStatus, injuryDescription,
      featuredStats, gameLog, spotlightStories,
    });
  }

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
          (team_id, player_id, player_name, nhl_team, position, position_detail, headshot_url, crest_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING id, team_id, player_id, player_name, nhl_team, position, position_detail, headshot_url, crest_url`)
        .bind(teamId, player_id, player_name, nhl_team || '', position, position_detail || '', normalizeHeadshotUrl(headshot_url), teamCrestUrl(nhl_team))
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
    const q = new URL(request.url).searchParams.get('q') || '';
    if (!q.trim() || q.trim().length < 2) return json([]);

    // Query the persistent D1 cache first
    const { results: dbResults } = await db
      .prepare(`SELECT player_id, name, position_code, nhl_team, sweater_num, headshot_url
                FROM nhl_players WHERE name LIKE ? ORDER BY name LIMIT 20`)
      .bind(`%${q.trim()}%`)
      .all();

    if (dbResults && dbResults.length > 0) {
      return json(dbResults.map(p => ({
        playerId: p.player_id,
        name: p.name,
        positionCode: p.position_code,
        teamAbbrev: p.nhl_team,
        sweaterNumber: p.sweater_num || '',
        headshot: normalizeHeadshotUrl(p.headshot_url),
      })));
    }

    // D1 cache empty (first run before cron) — fall back to in-memory roster fetch
    try {
      const allPlayers = await getNhlRosterCache();
      const lower = q.trim().toLowerCase();
      return json(allPlayers.filter(p => p.name.toLowerCase().includes(lower)).slice(0, 20));
    } catch {
      return json([]);
    }
  }

  if (pathname === '/api/standings/refresh' && request.method === 'POST') {
    clearNhlCache();
    return json({ success: true });
  }

  if (pathname === '/api/admin/eliminated-teams' && request.method === 'GET') {
    const season = getCurrentSeason();
    const { results } = await db
      .prepare('SELECT abbrev FROM eliminated_teams WHERE season = ? ORDER BY abbrev')
      .bind(season)
      .all();
    return json({ season, eliminatedTeams: (results || []).map(r => r.abbrev) });
  }

  if (pathname === '/api/admin/eliminated-teams' && request.method === 'POST') {
    const authErr = requireAuth(request, env); if (authErr) return authErr;
    const season = getCurrentSeason();
    const body = await request.json();
    const teams = (body.teams || []).map(t => t.toString().trim().toUpperCase()).filter(Boolean);

    await db.prepare('DELETE FROM eliminated_teams WHERE season = ?').bind(season).run();
    if (teams.length > 0) {
      await Promise.all(
        teams.map(abbrev =>
          db.prepare('INSERT OR IGNORE INTO eliminated_teams (abbrev, season) VALUES (?, ?)')
            .bind(abbrev, season)
            .run()
        )
      );
    }
    return json({ success: true, season, eliminatedTeams: teams });
  }

  if (pathname === '/api/admin/sync-nhl-players' && request.method === 'POST') {
    const authErr = requireAuth(request, env); if (authErr) return authErr;
    try {
      nhlRosterCache = null; // force fresh fetch
      const count = await syncNhlRosters(db);
      return json({ ok: true, synced: count });
    } catch (e) {
      return json({ error: e.message }, { status: 500 });
    }
  }

  if (pathname === '/api/admin/backfill-headshots' && request.method === 'POST') {
    const authErr = requireAuth(request, env); if (authErr) return authErr;
    const { results: players } = await db.prepare('SELECT DISTINCT player_id, headshot_url FROM team_players').all();
    let updated = 0;
    let cleared = 0;
    await Promise.all((players || []).map(async ({ player_id, headshot_url }) => {
      try {
        const res = await fetch(`${NHL_BASE}/player/${player_id}/landing`, {
          headers: { 'User-Agent': 'PlayoffFantasy/1.0 (Cloudflare Worker)' }
        });
        if (!res.ok) return;
        const data = await res.json();
        const headshot = normalizeHeadshotUrl(data.headshot);
        if (!headshot) {
          if (headshot_url && isDefaultHeadshotUrl(headshot_url)) {
            await db.prepare('UPDATE team_players SET headshot_url = ? WHERE player_id = ?')
              .bind('', player_id).run();
            cleared++;
          }
          return;
        }
        await db.prepare('UPDATE team_players SET headshot_url = ? WHERE player_id = ?')
          .bind(headshot, player_id).run();
        updated++;
      } catch {}
    }));
    return json({ success: true, updated, cleared });
  }

  if (pathname === '/api/debug/bracket' && request.method === 'GET') {
    const season = getCurrentSeason();
    try {
      const res = await fetch(`${NHL_BASE}/playoff-bracket/${season}`, {
        headers: { 'User-Agent': 'PlayoffFantasy/1.0 (Cloudflare Worker)' }
      });
      const body = await res.json();
      const eliminatedTeams = await getEliminatedTeams(season, db);
      return json({ status: res.status, season, eliminatedTeams, rawBracket: body });
    } catch (e) {
      return json({ error: e.message, season });
    }
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
      const playoffEntry = getSeasonStats(body, season, 3);
      return json({ status: data.status, season, playoffEntry, seasonTotalsCount: (body.seasonTotals || []).length });
    } catch (e) {
      return json({ error: e.message, season });
    }
  }

  if (pathname === '/api/standings' && request.method === 'GET') {
    // Legacy single-pool standings (all teams, default scoring).
    return json(await computeStandings(db, { leagueId: null, season: getCurrentSeason(), config: DEFAULT_LEAGUE_CONFIG }));
  }

  return json({ error: 'Not found' }, { status: 404 });
}

// Compute standings for one league (or the legacy global pool when leagueId is
// null). Fetches NHL data, scores per the league's config, writes snapshots, and
// falls back to the last good result for that league on NHL API failure.
async function computeStandings(db, { leagueId, season, seasonType = 'playoffs', config }) {
  const cfg = config || DEFAULT_LEAGUE_CONFIG;
  const gameTypeId = seasonType === 'regular' ? 2 : 3;
  const cacheKey = leagueId == null ? '__global__' : String(leagueId);
  let confirmedActiveGoalies = confirmedActiveGoaliesByLeague.get(cacheKey);
  if (!confirmedActiveGoalies) {
    confirmedActiveGoalies = new Map();
    confirmedActiveGoaliesByLeague.set(cacheKey, confirmedActiveGoalies);
  }

    try {
      const teams = leagueId == null ? await getTeams(db) : await getLeagueTeams(db, leagueId);
      const teamsWithPlayers = await Promise.all(
        teams.map(async (team) => ({ ...team, players: await getTeamPlayers(db, team.id) }))
      );

      // Fetch all unique player landing pages in parallel
      const allPlayerIds = [...new Set(
        teamsWithPlayers.flatMap(t => t.players.map(p => p.player_id))
      )];
      const snapshotMap = await getPlayerSnapshotMap(db, season, gameTypeId, allPlayerIds);
      const playersMissingHeadshots = new Set(
        teamsWithPlayers
          .flatMap((t) => t.players)
          .filter((p) => !normalizeHeadshotUrl(p.headshot_url))
          .map((p) => p.player_id)
      );
      const staleOrMissingIds = allPlayerIds.filter(
        (id) => !isSnapshotFresh(snapshotMap[id]?.fetched_at) || playersMissingHeadshots.has(id)
      );
      let snapshotWriteErrors = 0;
      const now = new Date().toISOString();
      const fetchedEntries = await Promise.all(
        staleOrMissingIds.map(async id => {
          try {
            const data = await cachedNhlFetch(`player-${id}`, `${NHL_BASE}/player/${id}/landing`);
            const seasonStats = getSeasonStats(data, season, gameTypeId);
            const headshot = normalizeHeadshotUrl(data?.headshot);
            if (headshot) {
              await db.prepare('UPDATE team_players SET headshot_url = ? WHERE player_id = ?')
                .bind(headshot, id)
                .run();
            }
            await db
              .prepare(
                `INSERT INTO player_stats_snapshots (player_id, season, game_type, stats_json, fetched_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(player_id, season, game_type) DO UPDATE SET
                   stats_json = excluded.stats_json,
                   fetched_at = excluded.fetched_at`
              )
              .bind(id, season, gameTypeId, JSON.stringify(seasonStats), now)
              .run();
            return [id, { stats: seasonStats, headshot }];
          } catch (err) {
            console.error(`[snapshot] failed to write player ${id}:`, err?.message ?? err);
            snapshotWriteErrors++;
            return [id, { stats: null, headshot: '' }];
          }
        })
      );
      const fetchedDataMap = Object.fromEntries(fetchedEntries);
      const playerDataMap = Object.fromEntries(
        allPlayerIds.map((id) => {
          const cached = snapshotMap[id]?.stats_json ? JSON.parse(snapshotMap[id].stats_json) : null;
          const latest = Object.prototype.hasOwnProperty.call(fetchedDataMap, id)
            ? (fetchedDataMap[id]?.stats ?? cached)
            : cached;
          return [id, latest];
        })
      );
      const fetchedHeadshotMap = Object.fromEntries(
        Object.entries(fetchedDataMap).map(([id, data]) => [id, normalizeHeadshotUrl(data?.headshot)])
      );

      // Build normalized stat maps keyed by player_id
      const skaterMap = {};
      const goalieMap = {};
      for (const team of teamsWithPlayers) {
        for (const p of team.players) {
          if (p.player_id in skaterMap || p.player_id in goalieMap) continue;
          const entry = playerDataMap[p.player_id] ?? null;
          if (p.position === 'G') {
            goalieMap[p.player_id] = normalizeGoalie(entry, p.player_id);
          } else {
            skaterMap[p.player_id] = normalizeSkater(entry, p.player_id);
          }
        }
      }

      // Fetch GAA from dedicated leaders endpoint — seasonTotals omits goalsAgainstAvg
      try {
        const gaaLeaders = await cachedNhlFetch(
          `goalie-gaa-${season}-${gameTypeId}`,
          `${NHL_BASE}/goalie-stats-leaders/${season}/${gameTypeId}?categories=goalsAgainstAvg&limit=500`
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
              const winsPoints = (stats.wins ?? 0) * cfg.scoring.goalie.win;
              const shutoutPoints = (stats.shutouts ?? 0) * cfg.scoring.goalie.shutout;
              const gaaRank = cfg.scoring.goalie.gaaRank ? (gaaRankMap[p.player_id] ?? 0) : 0;
              const svpRank = cfg.scoring.goalie.svpRank ? (svpRankMap[p.player_id] ?? 0) : 0;
              points = winsPoints + shutoutPoints + gaaRank + svpRank;
              breakdown = { winsPoints, shutoutPoints, gaaRank, svpRank };
            }
          } else {
            stats = skaterMap[p.player_id] ?? null;
            if (stats) {
              const goalPoints = (stats.goals ?? 0) * cfg.scoring.skater.goal;
              const assistPoints = (stats.assists ?? 0) * cfg.scoring.skater.assist;
              const stPoints =
                ((stats.ppGoals ?? 0) +
                (stats.ppAssists ?? 0) +
                (stats.shGoals ?? 0) +
                (stats.shAssists ?? 0)) * cfg.scoring.skater.specialTeamsPointBonus;
              const pimPoints = (stats.penaltyMinutes ?? 0) * cfg.scoring.skater.pim;
              const pmPoints = stats.plusMinus ?? 0;
              points = goalPoints + assistPoints + stPoints + pimPoints + pmPoints;
              breakdown = { goalPoints, assistPoints, stPoints, pimPoints, pmPoints };
            }
          }

          totalPoints += points;
          return {
            ...p,
            headshot_url: normalizeHeadshotUrl(p.headshot_url) || fetchedHeadshotMap[p.player_id] || '',
            stats,
            points: Math.round(points * 10) / 10,
            breakdown
          };
        });

        return { ...team, players, totalPoints: Math.round(totalPoints * 10) / 10 };
      });

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
      let teamSnapshotErrors = 0;
      await Promise.all(
        standings.map((team) =>
          db
            .prepare(
              `INSERT INTO team_points_snapshots (team_id, season, total_points, computed_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(team_id, season) DO UPDATE SET
                 total_points = excluded.total_points,
                 computed_at = excluded.computed_at`
            )
            .bind(team.id, season, team.totalPoints, now)
            .run()
            .catch((err) => {
              console.error(`[snapshot] failed to write team ${team.id}:`, err?.message ?? err);
              teamSnapshotErrors++;
            })
        )
      );

      const fetchedCount = staleOrMissingIds.length;
      const withSeasonData = Object.values(playerDataMap).filter(Boolean).length;
      const result = { standings, season, seasonType, poolGoalieCount: n, eliminatedTeams, lastUpdated: new Date().toISOString(), _debug: { totalPlayers: allPlayerIds.length, fetchedCount, withSeasonData, snapshotWriteErrors, teamSnapshotErrors } };
      lastSuccessfulStandingsByLeague.set(cacheKey, result);
      return result;
    } catch (e) {
      const last = lastSuccessfulStandingsByLeague.get(cacheKey);
      if (last) {
        return { ...last, stale: true, error: e.message };
      }
      const teams = leagueId == null ? await getTeams(db) : await getLeagueTeams(db, leagueId);
      const standings = await Promise.all(
        teams.map(async (t) => ({
          ...t,
          players: (await getTeamPlayers(db, t.id)).map((p) => ({
            ...p,
            headshot_url: normalizeHeadshotUrl(p.headshot_url),
            stats: null,
            points: 0,
            breakdown: {}
          })),
          totalPoints: 0
        }))
      );

      return {
        standings,
        season,
        poolGoalieCount: 0,
        lastUpdated: new Date().toISOString(),
        error: e.message
      };
    }
}

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
    const pos = meta.position || '';
    const capKey = pos === 'G' ? 'maxG' : pos === 'D' ? 'maxD' : 'maxF';

    const leagueRow = await db.prepare('SELECT config_json FROM leagues WHERE id = ?').bind(leagueId).first();
    const cfg = mergeConfig(leagueRow?.config_json);
    const { results: currentRoster } = await db.prepare(
      `SELECT id FROM team_players WHERE team_id = ? AND position = ?`
    ).bind(winnerClaim.team_id, pos).all();
    const atCap = (currentRoster || []).length >= (cfg.roster[capKey] ?? 99);

    if (atCap && !winnerClaim.drop_player_id) {
      // Winning team is at cap and didn't specify a drop — deny their claim, player becomes free agent
      await db.prepare(`UPDATE waiver_claims SET status = 'denied', processed_at = ?
        WHERE id = ?`).bind(now, winnerClaim.id).run();
      await db.prepare(`UPDATE dropped_players SET status = 'free_agent' WHERE id = ?`).bind(dp.id).run();
      continue;
    }

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

    try {
      await db.batch(batchOps);
    } catch {
      console.error(`[cron] waiver claim ${winnerClaim.id} batch failed (unique constraint?)`, leagueId);
      continue;
    }

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

    // Verify every player is still on their original team
    let valid = true;
    for (const item of (items || [])) {
      const still = await db.prepare('SELECT id FROM team_players WHERE team_id = ? AND player_id = ?')
        .bind(item.from_team_id, item.player_id).first();
      if (!still) { valid = false; break; }
    }

    if (!valid) {
      await db.prepare(`UPDATE trade_proposals SET status = 'expired' WHERE id = ?`).bind(trade.id).run();
      continue;
    }

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

    try {
      await db.batch(batchOps);
    } catch {
      await db.prepare(`UPDATE trade_proposals SET status = 'expired' WHERE id = ?`).bind(trade.id).run();
    }
  }

  // Expire stale pending trades
  await db.prepare(`
    UPDATE trade_proposals SET status = 'expired'
    WHERE league_id = ? AND status = 'pending' AND expires_at <= ?
  `).bind(leagueId, now).run();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url.pathname);
    }

    return env.ASSETS.fetch(request);
  },

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
      }
    } catch (err) {
      console.error('[cron] failed to list leagues:', err?.message ?? err);
    }
    // Sync NHL rosters to D1 for persistent player search
    try {
      nhlRosterCache = null; // force fresh roster data each cron run
      await syncNhlRosters(db);
    } catch (err) {
      console.error('[cron] NHL roster sync failed:', err?.message ?? err);
    }

    // Sync player injury status from NHL injury endpoint
    try {
      await syncInjuries(db);
    } catch (err) {
      console.error('[cron] syncInjuries failed:', err?.message ?? err);
    }

    // Refresh landing snapshots for all rostered players
    try {
      await refreshRosteredPlayerLandings(db);
    } catch (err) {
      console.error('[cron] refreshRosteredPlayerLandings failed:', err?.message ?? err);
    }

    // Also recompute the legacy global pool (covers any not-yet-migrated teams).
    try {
      await computeStandings(db, { leagueId: null, season: getCurrentSeason(), config: DEFAULT_LEAGUE_CONFIG });
    } catch {}
  }
};
