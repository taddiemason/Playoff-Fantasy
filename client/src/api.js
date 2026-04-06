function getPassword() {
  return localStorage.getItem('shlob_password') || ''
}

export function savePassword(pw) {
  localStorage.setItem('shlob_password', pw)
}

export function clearPassword() {
  localStorage.removeItem('shlob_password')
}

function authHeaders() {
  const pw = getPassword()
  return pw ? { 'Authorization': `Bearer ${pw}` } : {}
}

async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  });
  const data = await res.json();
  if (res.status === 401) {
    clearPassword()
    const err = new Error('Unauthorized')
    err.unauthorized = true
    throw err
  }
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

function mutate(url, options) {
  return request(url, { ...options, headers: { ...authHeaders(), ...options?.headers } })
}

export const api = {
  // Teams
  getTeams: () => request('/api/teams'),
  createTeam: (name, owner, tiebreaker) => mutate('/api/teams', {
    method: 'POST',
    body: JSON.stringify({ name, owner, tiebreaker })
  }),
  updateTeam: (id, name, owner, tiebreaker) => mutate(`/api/teams/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name, owner, tiebreaker })
  }),
  deleteTeam: (id) => mutate(`/api/teams/${id}`, { method: 'DELETE' }),

  // Players
  getPlayers: (teamId) => request(`/api/teams/${teamId}/players`),
  addPlayer: (teamId, player) => mutate(`/api/teams/${teamId}/players`, {
    method: 'POST',
    body: JSON.stringify(player)
  }),
  removePlayer: (teamId, playerId) => mutate(`/api/teams/${teamId}/players/${playerId}`, { method: 'DELETE' }),

  // NHL
  searchPlayers: (q) => request(`/api/nhl/search?q=${encodeURIComponent(q)}`),

  // Standings
  getStandings: () => request('/api/standings'),
  refreshStats: () => mutate('/api/standings/refresh', { method: 'POST' })
};
