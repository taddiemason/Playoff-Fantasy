async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

export const api = {
  // Teams
  getTeams: () => request('/api/teams'),
  createTeam: (name, owner) => request('/api/teams', {
    method: 'POST',
    body: JSON.stringify({ name, owner })
  }),
  updateTeam: (id, name, owner) => request(`/api/teams/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name, owner })
  }),
  deleteTeam: (id) => request(`/api/teams/${id}`, { method: 'DELETE' }),

  // Players
  getPlayers: (teamId) => request(`/api/teams/${teamId}/players`),
  addPlayer: (teamId, player) => request(`/api/teams/${teamId}/players`, {
    method: 'POST',
    body: JSON.stringify(player)
  }),
  removePlayer: (teamId, playerId) => request(`/api/teams/${teamId}/players/${playerId}`, { method: 'DELETE' }),

  // NHL
  searchPlayers: (q) => request(`/api/nhl/search?q=${encodeURIComponent(q)}`),

  // Standings
  getStandings: () => request('/api/standings'),
  refreshStats: () => request('/api/standings/refresh', { method: 'POST' })
};
