import { useState, useEffect, useCallback } from 'react'
import { useParams, useOutletContext, Link } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../auth/AuthContext.jsx'
import PlayerSearch from '../components/PlayerSearch.jsx'

export default function AddPlayers() {
  const { leagueId } = useParams()
  const { league } = useOutletContext()
  const { user } = useAuth()
  const isCommissioner = league.role === 'commissioner'
  const locked = league.is_locked && !isCommissioner

  const [teams, setTeams] = useState(null)
  const [selectedTeamId, setSelectedTeamId] = useState(null)
  const [roster, setRoster] = useState([])
  const [loadingRoster, setLoadingRoster] = useState(false)
  const [error, setError] = useState('')

  // Teams the current user may edit (their own, or all if commissioner).
  useEffect(() => {
    api.leagues.getTeams(leagueId)
      .then((all) => {
        const editable = all.filter((t) => t.user_id === user.id || isCommissioner)
        setTeams(editable)
        if (editable.length) setSelectedTeamId(String(editable[0].id))
      })
      .catch((err) => setError(err.message))
  }, [leagueId, user.id, isCommissioner])

  const loadRoster = useCallback(async (teamId) => {
    if (!teamId) return
    setLoadingRoster(true)
    try {
      setRoster(await api.leagues.getPlayers(leagueId, teamId))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoadingRoster(false)
    }
  }, [leagueId])

  useEffect(() => { if (selectedTeamId) loadRoster(selectedTeamId) }, [selectedTeamId, loadRoster])

  async function handleAdd(payload) {
    await api.leagues.addPlayer(leagueId, selectedTeamId, payload)
    await loadRoster(selectedTeamId)
  }

  return (
    <div>
      <Link to={`/leagues/${leagueId}`} className="back-link">← {league.name}</Link>
      <div className="page-header">
        <div className="page-title">Add Players</div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {teams === null ? (
        <div className="loading-state"><span className="loading-spinner"></span> Loading…</div>
      ) : teams.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">No team to manage</div>
          <div className="empty-state-desc">Create a team in this league first, then come back to draft players.</div>
          <Link to={`/leagues/${leagueId}`} className="btn btn-primary" style={{ marginTop: 16 }}>Go to league</Link>
        </div>
      ) : locked ? (
        <div className="alert alert-warn">This league is locked — rosters are final.</div>
      ) : (
        <>
          {teams.length > 1 && (
            <div className="form-group" style={{ maxWidth: 320 }}>
              <label className="form-label">Team</label>
              <select className="form-input" value={selectedTeamId || ''} onChange={(e) => setSelectedTeamId(e.target.value)}>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          {loadingRoster ? (
            <div className="loading-state"><span className="loading-spinner"></span> Loading roster…</div>
          ) : (
            <PlayerSearch roster={roster} caps={league.config.roster} onAdd={handleAdd} />
          )}
        </>
      )}
    </div>
  )
}
