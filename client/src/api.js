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
  const { headers, ...rest } = options
  const res = await fetch(url, {
    credentials: 'include',
    ...rest,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  const data = await res.json();
  if (res.status === 401) {
    clearPassword()
    const err = new Error(data.error || 'Unauthorized')
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
  getStandings: async () => {
    try {
      const data = await request('/api/standings')
      if (!data.stale) localStorage.setItem('standings_cache', JSON.stringify(data))
      return data
    } catch (err) {
      const cached = localStorage.getItem('standings_cache')
      if (cached) return { ...JSON.parse(cached), stale: true, error: err.message }
      throw err
    }
  },
  refreshStats: () => mutate('/api/standings/refresh', { method: 'POST' }),

  // Auth
  auth: {
    register: (data) => request('/api/auth/register', { method: 'POST', body: JSON.stringify(data) }),
    login: (identifier, password) => request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password })
    }),
    logout: () => request('/api/auth/logout', { method: 'POST' }),
    me: () => request('/api/auth/me'),
  },

  // Current user profile/settings
  me: {
    update: (data) => request('/api/me', { method: 'PATCH', body: JSON.stringify(data) }),
    changePassword: (currentPassword, newPassword) => request('/api/me/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword })
    }),
  },

  // Leagues (multi-tenant)
  leagues: {
    mine: () => request('/api/me/leagues'),
    create: (name, seasonType = 'playoffs') => request('/api/leagues', { method: 'POST', body: JSON.stringify({ name, season_type: seasonType }) }),
    get: (id) => request(`/api/leagues/${id}`),
    update: (id, data) => request(`/api/leagues/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

    getTeams: (id) => request(`/api/leagues/${id}/teams`),
    createTeam: (id, name, owner, tiebreaker) => request(`/api/leagues/${id}/teams`, {
      method: 'POST', body: JSON.stringify({ name, owner, tiebreaker })
    }),
    updateTeam: (id, teamId, name, owner, tiebreaker) => request(`/api/leagues/${id}/teams/${teamId}`, {
      method: 'PUT', body: JSON.stringify({ name, owner, tiebreaker })
    }),
    deleteTeam: (id, teamId) => request(`/api/leagues/${id}/teams/${teamId}`, { method: 'DELETE' }),

    getPlayers: (id, teamId) => request(`/api/leagues/${id}/teams/${teamId}/players`),
    addPlayer: (id, teamId, player) => request(`/api/leagues/${id}/teams/${teamId}/players`, {
      method: 'POST', body: JSON.stringify(player)
    }),
    removePlayer: (id, teamId, rowId) => request(`/api/leagues/${id}/teams/${teamId}/players/${rowId}`, {
      method: 'DELETE'
    }),

    getStandings: (id) => request(`/api/leagues/${id}/standings`),
    refreshStats: (id) => request(`/api/leagues/${id}/standings/refresh`, { method: 'POST' }),

    // Player Explorer
    explorer: (id) => request(`/api/leagues/${id}/players`),
    player: (id, playerId) => request(`/api/leagues/${id}/players/${playerId}`),

    // Commissioner
    getMembers: (id) => request(`/api/leagues/${id}/members`),
    removeMember: (id, userId) => request(`/api/leagues/${id}/members/${userId}`, { method: 'DELETE' }),
    getInvites: (id) => request(`/api/leagues/${id}/invites`),
    createInvite: (id, opts) => request(`/api/leagues/${id}/invites`, { method: 'POST', body: JSON.stringify(opts || {}) }),
    revokeInvite: (id, inviteId) => request(`/api/leagues/${id}/invites/${inviteId}`, { method: 'DELETE' }),

    // Schedule
    schedule: {
      get:      (id) => request(`/api/leagues/${id}/schedule`),
      generate: (id, startDate, numWeeks) => request(`/api/leagues/${id}/schedule/generate`, {
        method: 'POST', body: JSON.stringify({ start_date: startDate, num_weeks: numWeeks })
      }),
    },

    // Lineup
    lineup: {
      get: (id, teamId, periodId) => request(`/api/leagues/${id}/teams/${teamId}/lineup/${periodId}`),
      set: (id, teamId, periodId, activePlayerIds) => request(`/api/leagues/${id}/teams/${teamId}/lineup/${periodId}`, {
        method: 'PUT', body: JSON.stringify({ active_player_ids: activePlayerIds })
      }),
    },

    // Matchups
    matchup: {
      current:  (id) => request(`/api/leagues/${id}/matchups/current`),
      byPeriod: (id, periodId) => request(`/api/leagues/${id}/matchups/${periodId}`),
      score:    (id) => request(`/api/leagues/${id}/matchups/score`, { method: 'POST' }),
    },
  },

  // Invite codes (public preview + join)
  invites: {
    preview: (code) => request(`/api/invites/${code}`),
    join: (code) => request(`/api/invites/${code}/join`, { method: 'POST' }),
  }
};
