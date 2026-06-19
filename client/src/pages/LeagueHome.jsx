import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useParams, useOutletContext, Link } from 'react-router-dom'
import { api } from '../api.js'
import AddTeamModal from '../components/AddTeamModal.jsx'

const MEDALS = ['1', '2', '3']

export default function LeagueHome() {
  const { leagueId } = useParams()
  const { league } = useOutletContext()
  const navigate = useNavigate()
  const [standings, setStandings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [showAddTeam, setShowAddTeam] = useState(false)
  const [copied, setCopied] = useState(false)

  const config = league.config
  const isCommissioner = league.role === 'commissioner'

  const fetchStandings = useCallback(async () => {
    try {
      const data = await api.leagues.getStandings(leagueId)
      setStandings(data)
      setError(data.stale ? `Showing cached stats — live data unavailable (${data.error})` : data.error ? `NHL API: ${data.error}` : '')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [leagueId])

  useEffect(() => { fetchStandings() }, [fetchStandings])

  async function handleRefresh() {
    setRefreshing(true)
    await api.leagues.refreshStats(leagueId)
    await fetchStandings()
  }

  function copyInvite() {
    const link = `${window.location.origin}/join/${league.invite_code}`
    navigator.clipboard?.writeText(link)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const seasonStr = standings?.season ? `${standings.season.slice(0, 4)}–${standings.season.slice(4)}` : ''

  return (
    <div>
      <Link to="/dashboard" className="back-link">← All leagues</Link>

      <div className="league-hub-header">
        <div>
          <div className="page-title">{league.name}</div>
          <div className="page-subtitle">
            {seasonStr && `${seasonStr} ${league.season_type === 'regular' ? 'Regular Season' : 'NHL Playoffs'} · `}{league.memberCount ?? 0} members
            {league.is_locked && <span className="lock-pill"> Locked</span>}
          </div>
        </div>
        <div className="header-actions">
          {isCommissioner && (
            <button className="btn btn-ghost btn-sm" onClick={copyInvite}>
              {copied ? 'Copied!' : `Invite: ${league.invite_code}`}
            </button>
          )}
        </div>
      </div>

      {config.commissionerNotes && (
        <div className="alert alert-info commish-notes">📌 {config.commissionerNotes}</div>
      )}

      {config.description && (
        <div className="league-description"><p>{config.description}</p></div>
      )}

      <div className="page-header">
        <div className="page-title" style={{ fontSize: 18 }}>Standings</div>
        <div className="header-actions">
          <Link to={`/leagues/${leagueId}/standings`} className="btn btn-ghost btn-sm">Full standings →</Link>
          <button className="btn btn-ghost" onClick={handleRefresh} disabled={refreshing || loading}>
            {refreshing ? <><span className="loading-spinner"></span> Refreshing...</> : '↻ Refresh Stats'}
          </button>
          {!league.is_locked && (
            <button className="btn btn-primary" onClick={() => setShowAddTeam(true)}>+ Add Team</button>
          )}
        </div>
      </div>

      {error && <div className="alert alert-warn" style={{ marginBottom: 16 }}>{error}</div>}

      {loading ? (
        <div className="loading-state"><span className="loading-spinner"></span> Loading standings...</div>
      ) : standings?.standings?.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">No teams yet</div>
          <div className="empty-state-desc">Add the first fantasy team to get started</div>
          {!league.is_locked && (
            <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setShowAddTeam(true)}>+ Add Team</button>
          )}
        </div>
      ) : (
        <div className="standings-grid">
          {standings?.standings?.map((team, idx) => {
            const eliminatedSet = new Set((standings?.eliminatedTeams || []).map((t) => t.trim().toUpperCase()))
            const rank = idx + 1
            const rankClass = rank <= 3 ? `rank-${rank}` : ''
            const fwd = team.players.filter((p) => p.position === 'F').length
            const def = team.players.filter((p) => p.position === 'D').length
            const gol = team.players.filter((p) => p.position === 'G').length
            const totalPlayers = team.players.length
            const activePlayers = team.players.filter((p) => !eliminatedSet.has((p.nhl_team || '').trim().toUpperCase())).length
            const activeRatio = totalPlayers > 0 ? activePlayers / totalPlayers : 1
            const activeClass = activeRatio > 0.66 ? 'active-high' : activeRatio > 0.33 ? 'active-mid' : 'active-low'

            return (
              <div key={team.id} className={`team-card ${rankClass}`} onClick={() => navigate(`/leagues/${leagueId}/teams/${team.id}`)}>
                <div className="team-rank">{rank <= 3 ? MEDALS[rank - 1] : rank}</div>
                <div className="team-info">
                  <div className="team-name">{team.name}</div>
                  {team.owner && <div className="team-owner">{team.owner}</div>}
                  <div className="team-roster-summary">
                    {fwd > 0 && <span className="roster-pill f">{fwd}/{config.roster.maxF} F</span>}
                    {def > 0 && <span className="roster-pill d">{def}/{config.roster.maxD} D</span>}
                    {gol > 0 && <span className="roster-pill g">{gol}/{config.roster.maxG} G</span>}
                    {fwd === 0 && def === 0 && gol === 0 && (
                      <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>No players added</span>
                    )}
                  </div>
                  {totalPlayers > 0 && league.season_type !== 'regular' && (
                    <div className={`players-remaining ${activeClass}`}>{activePlayers}/{totalPlayers} active</div>
                  )}
                  {team.tiebreaker && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>TB: {team.tiebreaker}</div>
                  )}
                </div>
                <div className="team-points">
                  <div className="points-value">{team.totalPoints}</div>
                  <div className="points-label">pts</div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showAddTeam && (
        <AddTeamModal
          leagueId={leagueId}
          seasonType={league.season_type || 'playoffs'}
          onClose={() => setShowAddTeam(false)}
          onCreated={() => { setShowAddTeam(false); fetchStandings() }}
        />
      )}
    </div>
  )
}
