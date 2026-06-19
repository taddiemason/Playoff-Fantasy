// Authentication helpers for the Cloudflare Worker.
// Password hashing uses Web Crypto PBKDF2-HMAC-SHA256 (scrypt/argon2 aren't
// available in Workers without WASM). Sessions are random opaque tokens stored
// in the `sessions` table and carried in an HttpOnly cookie.

const PBKDF2_ITERS = 100000;
const SESSION_TTL_DAYS = 30;
const COOKIE_NAME = 'sid';

function b64encode(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function b64decode(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

async function deriveBits(password, salt, iters) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' },
    key,
    256
  );
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await deriveBits(password, salt, PBKDF2_ITERS);
  return `pbkdf2$${PBKDF2_ITERS}$${b64encode(salt)}$${b64encode(bits)}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, itersStr, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'pbkdf2') return false;
    const salt = b64decode(saltB64);
    const bits = await deriveBits(password, salt, parseInt(itersStr, 10));
    const a = new Uint8Array(bits);
    const b = b64decode(hashB64);
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  } catch {
    return false;
  }
}

export function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isSecure(request) {
  try {
    const url = new URL(request.url);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return false;
    return url.protocol === 'https:';
  } catch {
    return true;
  }
}

export function sessionCookie(token, request, maxAgeSec = SESSION_TTL_DAYS * 24 * 3600) {
  const secure = isSecure(request) ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure}`;
}

export function clearCookie(request) {
  const secure = isSecure(request) ? '; Secure' : '';
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

export async function createSession(db, userId) {
  const token = generateToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 3600 * 1000);
  await db
    .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(token, userId, now.toISOString(), expires.toISOString())
    .run();
  return token;
}

export async function getSessionUser(db, request) {
  const token = parseCookies(request)[COOKIE_NAME];
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.username, u.avatar_url, u.is_site_admin, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`
    )
    .bind(token)
    .first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(token).run();
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    avatar_url: row.avatar_url || '',
    is_site_admin: !!row.is_site_admin,
  };
}

export async function deleteSession(db, request) {
  const token = parseCookies(request)[COOKIE_NAME];
  if (token) await db.prepare('DELETE FROM sessions WHERE id = ?').bind(token).run();
}
