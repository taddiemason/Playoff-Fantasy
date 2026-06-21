import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, useOutletContext, Link } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../auth/AuthContext.jsx'
import AddPlayerModal from '../components/AddPlayerModal.jsx'
import PlayerStatusBadge from '../components/PlayerStatusBadge.jsx'

const POS_ICON = { F: 'F', D: 'D', G: 'G' }
const POS_CLASS = { F: 'forwards', D: 'defense', G: 'goalies' }

function PlayerRow({ player, onRemove, eliminated, canEdit, leagueId, injuryStatus, injuryDescription }) {
  const [showBreakdown, setShowBreakdown] = useState(false)
  const [removing, setRemoving] = useState(false)
  const { stats, breakdown, points, position, position_detail } = player
  const [headshotFailed, setHeadshotFailed] = useState(false)
  const showHeadshot = player.headshot_url && !headshotFailed

  async function handleRemove() {
    if (!confirm(`Remove ${player.player_name} from this team?`)) return
    setRemoving(true)
    try { await onRemove(player.id) }
    finally { setRemoving(false) }
  }

  const posClass = position.toLowerCase()
  const crestUrl = player.crest_url || null

  return (
    <div className={`player-row${eliminated ? ' eliminated' : ''}`}>
      <div className="player-row-main">
        {crestUrl && <img src={crestUrl} alt="" className="player-team-crest" aria-hidden="true" />}
        {showHeadshot
          ? <img src={player.headshot_url} alt="" className="player-headshot" onError={() => setHeadshotFailed(true)} />
          : <div className="player-headshot-placeholder">{POS_ICON[position]}</div>}

        <div className="player-info">
          <div className="player-name">
              <Link to={`/leagues/${leagueId}/players/${player.player_id}`}>{player.player_name}</Link>
              <PlayerStatusBadge injuryStatus={injuryStatus} injuryDescription={injuryDescription} />
            </div>
          <div className="player-meta">
            {player.nhl_team && <span className="player-team-badge">{player.nhl_team}</span>}
            <span className={`player-pos-badge ${posClass}`}>{position_detail || position}</span>
          </div>
        </div>

        {position !== 'G' && stats && (
          <div className="player-stats-mini">
            <div className="stat-chip"><div className="stat-chip-value">{stats.goals ?? 0}</div><div className="stat-chip-label">G</div></div>
            <div className="stat-chip"><div className="stat-chip-value">{stats.assists ?? 0}</div><div className="stat-chip-label">A</div></div>
            <div className="stat-chip">
              <div className={`stat-chip-value ${(stats.plusMinus ?? 0) > 0 ? 'pm-positive' : (stats.plusMinus ?? 0) < 0 ? 'pm-negative' : ''}`}>
                {(stats.plusMinus ?? 0) > 0 ? '+' : ''}{stats.plusMinus ?? 0}
              </div>
              <div className="stat-chip-label">+/-</div>
            </div>
            <div className="stat-chip"><div className="stat-chip-value">{stats.penaltyMinutes ?? 0}</div><div className="stat-chip-label">PIM</div></div>
          </div>
        )}
        {position === 'G' && stats && (
          <div className="player-stats-mini">
            <div className="stat-chip"><div className="stat-chip-value">{stats.wins ?? 0}</div><div className="stat-chip-label">W</div></div>
            <div className="stat-chip"><div className="stat-chip-value">{stats.shutouts ?? 0}</div><div className="stat-chip-label">SO</div></div>
            <div className="stat-chip"><div className="stat-chip-value">{stats.goalsAgainstAverage?.toFixed(2) ?? '–'}</div><div className="stat-chip-label">GAA</div></div>
            <div className="stat-chip"><div className="stat-chip-value">{stats.savePct ? (stats.savePct * 1).toFixed(3) : '–'}</div><div className="stat-chip-label">SV%</div></div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            {stats ? (
              <>
                <div className={`player-points-chip${eliminated ? ' eliminated' : ''}`}>
                  <span className="player-points-chip-label">pts</span>
                  <span className="player-points-chip-value">{points}</span>
                </div>
                <button className="breakdown-toggle" onClick={() => setShowBreakdown((s) => !s)}>
                  {showBreakdown ? '▲' : '▼'} breakdown
                </button>
              </>
            ) : (
              <span className="no-stats-msg">No data</span>
            )}
          </div>
          {canEdit && (
            <button className="btn btn-icon btn-danger" onClick={handleRemove} disabled={removing} title="Remove player">
              {removing ? <span className="loading-spinner" style={{ width: 12, height: 12 }}></span> : '×'}
            </button>
          )}
        </div>
      </div>

      {showBreakdown && stats && (
        <div className="breakdown-panel">
          {position !== 'G' ? (
            <>
              <div className="breakdown-item"><div className="breakdown-value">{breakdown.goalPoints ?? 0}</div><div className="breakdown-label">{stats.goals ?? 0}G</div></div>
              <div className="breakdown-item"><div className="breakdown-value">{breakdown.assistPoints ?? 0}</div><div className="breakdown-label">{stats.assists ?? 0}A</div></div>
              <div className="breakdown-item"><div className="breakdown-value">{breakdown.stPoints ?? 0}</div><div className="breakdown-label">{((stats.ppGoals ?? 0) + (stats.ppAssists ?? 0) + (stats.shGoals ?? 0) + (stats.shAssists ?? 0))} ST pts</div></div>
              <div className="breakdown-item"><div className="breakdown-value">{breakdown.pimPoints ?? 0}</div><div className="breakdown-label">{stats.penaltyMinutes ?? 0} PIM</div></div>
              <div className="breakdown-item">
                <div className={`breakdown-value ${(breakdown.pmPoints ?? 0) > 0 ? 'positive' : (breakdown.pmPoints ?? 0) < 0 ? 'negative' : ''}`}>
                  {(breakdown.pmPoints ?? 0) > 0 ? '+' : ''}{breakdown.pmPoints ?? 0}
                </div>
                <div className="breakdown-label">+/- ({stats.plusMinus ?? 0})</div>
              </div>
            </>
          ) : (
            <>
              <div className="breakdown-item"><div className="breakdown-value">{breakdown.winsPoints ?? 0}</div><div className="breakdown-label">{stats.wins ?? 0}W</div></div>
              <div className="breakdown-item"><div className="breakdown-value">{breakdown.shutoutPoints ?? 0}</div><div className="breakdown-label">{stats.shutouts ?? 0} SO</div></div>
              <div className="breakdown-item"><div className="breakdown-value">{breakdown.gaaRank ?? 0}</div><div className="breakdown-label">GAA Rank ({stats.goalsAgainstAverage?.toFixed(2)})</div></div>
              <div className="breakdown-item"><div className="breakdown-value">{breakdown.svpRank ?? 0}</div><div className="breakdown-label">SV% Rank ({stats.savePct?.toFixed(3)})</div></div>
            </>
          )}
          <div className="breakdown-item" style={{ marginLeft: 'auto', borderLeft: '1px solid var(--border)', paddingLeft: 20 }}>
            <div className="breakdown-value" style={{ color: 'var(--primary)', fontSize: 20 }}>{points}</div>
            <div className="breakdown-label">Total</div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function TeamDetail() {
  const { leagueId, teamId } = useParams()
  const { league } = useOutletContext()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [teamData, setTeamData] = useState(null)
  const [eliminatedTeams, setEliminatedTeams] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [injuryMap, setInjuryMap] = useState({})
  const [showAddPlayer, setShowAddPlayer] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [editingTiebreaker, setEditingTiebreaker] = useState(false)
  const [tiebreakerVal, setTiebreakerVal] = useState('')
  const [tiebreakerErr, setTiebreakerErr] = useState('')

  const config = league.config
  const isCommissioner = league.role === 'commissioner'

  const fetchTeam = useCallback(async () => {
    setLoading(true)
    try {
      const [standingsData, injuredPlayers] = await Promise.all([
        api.leagues.getStandings(leagueId),
        api.leagues.getPlayers(leagueId, teamId),
      ])
      const found = standingsData.standings?.find((t) => t.id === parseInt(teamId))
      if (found) {
        setTeamData({ team: found, poolGoalieCount: standingsData.poolGoalieCount })
        setEliminatedTeams(standingsData.eliminatedTeams || [])
      } else {
        setError('Team not found')
      }
      const map = {}
      for (const p of (injuredPlayers || [])) {
        map[p.player_id] = { injuryStatus: p.injuryStatus || '', injuryDescription: p.injuryDescription || '' }
      }
      setInjuryMap(map)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [leagueId, teamId])

  useEffect(() => { fetchTeam() }, [fetchTeam])

  const canEdit = !!teamData && (teamData.team.user_id === user.id || isCommissioner) && (!league.is_locked || isCommissioner)

  async function handleRemovePlayer(rowId) {
    try {
      await api.leagues.removePlayer(leagueId, teamId, rowId)
      await fetchTeam()
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleDeleteTeam() {
    if (!confirm(`Delete team "${teamData?.team?.name}"? This cannot be undone.`)) return
    setDeleting(true)
    try {
      await api.leagues.deleteTeam(leagueId, teamId)
      navigate(`/leagues/${leagueId}`)
    } catch (err) {
      setError(err.message)
      setDeleting(false)
    }
  }

  function startEditTiebreaker() {
    setTiebreakerVal(teamData?.team?.tiebreaker || '')
    setTiebreakerErr('')
    setEditingTiebreaker(true)
  }

  async function saveTiebreaker() {
    const val = tiebreakerVal.trim()
    if (val && (!/^\d*\.\d{1,4}$/.test(val) || parseFloat(val) < 0 || parseFloat(val) > 1)) {
      setTiebreakerErr('Must be a decimal between 0 and 1 with up to 4 decimal places (e.g. .9145)')
      return
    }
    try {
      const { team } = teamData
      await api.leagues.updateTeam(leagueId, teamId, team.name, team.owner, val || null)
      setEditingTiebreaker(false)
      await fetchTeam()
    } catch (err) {
      setTiebreakerErr(err.message)
    }
  }

  if (loading) return <div className="loading-state"><span className="loading-spinner"></span> Loading team...</div>

  if (error) return (
    <div>
      <Link to={`/leagues/${leagueId}`} className="back-link">← Back to {league.name}</Link>
      <div className="alert alert-error">{error}</div>
    </div>
  )

  const { team } = teamData
  const forwards = team.players.filter((p) => p.position === 'F')
  const defensemen = team.players.filter((p) => p.position === 'D')
  const goalies = team.players.filter((p) => p.position === 'G')
  const roster = team.players
  const existingPlayerIds = new Set(roster.map((p) => p.player_id))

  const sections = [
    { key: 'F', label: 'Forwards', players: forwards, max: config.roster.maxF },
    { key: 'D', label: 'Defensemen', players: defensemen, max: config.roster.maxD },
    { key: 'G', label: 'Goalies', players: goalies, max: config.roster.maxG },
  ]

  const eliminatedSet = new Set(eliminatedTeams.map((t) => (t || '').toString().trim().toUpperCase()).filter(Boolean))

  return (
    <div>
      <Link to={`/leagues/${leagueId}`} className="back-link">← Back to {league.name}</Link>

      <div className="team-detail-header">
        <div>
          <div className="team-detail-name">{team.name}</div>
          {team.owner && <div className="team-detail-owner">Owner: {team.owner}</div>}
          <div className="team-roster-summary" style={{ marginTop: 8 }}>
            <span className="roster-pill f">{forwards.length}/{config.roster.maxF} F</span>
            <span className="roster-pill d">{defensemen.length}/{config.roster.maxD} D</span>
            <span className="roster-pill g">{goalies.length}/{config.roster.maxG} G</span>
          </div>
          <div className="tiebreaker-row">
            <span className="tiebreaker-label">Tiebreaker (Cup Goalie SV%):</span>
            {editingTiebreaker ? (
              <span className="tiebreaker-edit">
                <input className="form-input tiebreaker-input" value={tiebreakerVal} onChange={(e) => setTiebreakerVal(e.target.value)} placeholder=".9145" maxLength={6} autoFocus />
                <button className="btn btn-primary btn-sm" onClick={saveTiebreaker}>Save</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditingTiebreaker(false)}>Cancel</button>
                {tiebreakerErr && <span className="tiebreaker-err">{tiebreakerErr}</span>}
              </span>
            ) : canEdit ? (
              <span className="tiebreaker-value" onClick={startEditTiebreaker}>
                {team.tiebreaker || <span style={{ color: 'var(--text-dim)' }}>Not set — click to add</span>}
                <span className="tiebreaker-edit-hint"> (edit)</span>
              </span>
            ) : (
              <span style={{ color: team.tiebreaker ? 'var(--text)' : 'var(--text-dim)' }}>{team.tiebreaker || 'Not set'}</span>
            )}
          </div>
        </div>
        <div>
          <div className="team-total-points">
            <div className="team-total-value">{team.totalPoints}</div>
            <div className="team-total-label">Fantasy Points</div>
          </div>
        </div>
      </div>

      {canEdit && (
        <div className="page-header">
          <div></div>
          <div className="header-actions">
            <button className="btn btn-danger btn-sm" onClick={handleDeleteTeam} disabled={deleting}>
              {deleting ? 'Deleting...' : 'Delete Team'}
            </button>
            <button className="btn btn-primary" onClick={() => setShowAddPlayer(true)}>+ Add Player</button>
          </div>
        </div>
      )}

      {sections.map(({ key, label, players, max }) => (
        <div key={key} className="roster-section">
          <div className="roster-section-header">
            <div className={`section-title ${POS_CLASS[key]}`}>
              {POS_ICON[key]} {label}
              <span className="section-count">{players.length}/{max}</span>
            </div>
          </div>
          {players.length === 0 ? (
            <div style={{ color: 'var(--text-dim)', fontSize: 13, padding: '8px 4px' }}>No {label.toLowerCase()} added yet</div>
          ) : (
            players.map((player) => (
              <PlayerRow
                key={player.id}
                player={player}
                onRemove={handleRemovePlayer}
                eliminated={eliminatedSet.has((player.nhl_team || '').trim().toUpperCase())}
                canEdit={canEdit}
                leagueId={leagueId}
                injuryStatus={injuryMap[player.player_id]?.injuryStatus || ''}
                injuryDescription={injuryMap[player.player_id]?.injuryDescription || ''}
              />
            ))
          )}
        </div>
      ))}

      {showAddPlayer && (
        <AddPlayerModal
          leagueId={leagueId}
          teamId={teamId}
          roster={roster}
          existingPlayerIds={existingPlayerIds}
          caps={config.roster}
          onClose={() => setShowAddPlayer(false)}
          onAdded={() => { setShowAddPlayer(false); fetchTeam() }}
        />
      )}
    </div>
  )
}
