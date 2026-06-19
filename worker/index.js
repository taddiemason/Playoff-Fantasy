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

const CACHE_TTL_MS = 5 * 60 * 1000;
const STATS_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const nhlCache = new Map(); // keyed by player-{id}, cleared on refresh (shared raw NHL data)

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
        `INSERT INTO leagues (name, owner_user_id, season, season_type, config_json, invite_code)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
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
    return json({ active, bench, slots, locked });
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
    return json(await getTeamPlayers(db, teamId));
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
    const players = [...map.values()]
      .map((p) => ({ ...p, ownerCount: p.owners.length, ownershipPct: totalTeams ? Math.round((p.owners.length / totalTeams) * 100) : 0 }))
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
    return json({
      player, stats, points, breakdown, partial,
      owners, ownerCount: owners.length,
      ownershipPct: totalTeams ? Math.round((owners.length / totalTeams) * 100) : 0,
      totalTeams, eliminated, season,
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
    const searchParams = new URL(request.url).searchParams;
    const q = searchParams.get('q') || '';
    if (!q.trim() || q.trim().length < 2) return json([]);
    try {
      const searchUrl = `https://search.d3.nhle.com/api/v1/search?q=${encodeURIComponent(q.trim())}&type=player&culture=en-us&limit=20`;
      const response = await fetch(searchUrl, {
        headers: { 'User-Agent': 'PlayoffFantasy/1.0 (github.com/Zmalski/NHL-API-Reference)' }
      });
      if (!response.ok) throw new Error(`NHL search ${response.status}`);
      const data = await response.json();
      return json((data || []).map(p => ({
        playerId: p.playerId,
        name: p.name,
        positionCode: p.positionCode || '',
        teamAbbrev: p.teamAbbrev || '',
        sweaterNumber: p.sweaterNumber || '',
        headshot: normalizeHeadshotUrl(p.headshot),
      })));
    } catch {
      // Fallback to DB search if NHL search API is unreachable
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
        headshot: normalizeHeadshotUrl(p.headshot_url),
      })));
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

      standings.sort((a, b) => b.totalPoints - a.totalPoints);
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
      }
    } catch (err) {
      console.error('[cron] failed to list leagues:', err?.message ?? err);
    }
    // Also recompute the legacy global pool (covers any not-yet-migrated teams).
    try {
      await computeStandings(db, { leagueId: null, season: getCurrentSeason(), config: DEFAULT_LEAGUE_CONFIG });
    } catch {}
  }
};
