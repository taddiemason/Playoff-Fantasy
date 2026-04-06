import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { api } from '../api.js'
import AddPlayerModal from '../components/AddPlayerModal.jsx'
import PasswordModal from '../components/PasswordModal.jsx'

const POS_LABEL = { F: 'Forwards', D: 'Defensemen', G: 'Goalies' }
const POS_ICON = { F: 'F', D: 'D', G: 'G' }
const POS_CLASS = { F: 'forwards', D: 'defense', G: 'goalies' }

function PlayerRow({ player, onRemove }) {
  const [showBreakdown, setShowBreakdown] = useState(false)
  const [removing, setRemoving] = useState(false)
  const { stats, breakdown, points, position, position_detail } = player

  async function handleRemove() {
    if (!confirm(`Remove ${player.player_name} from this team?`)) return
    setRemoving(true)
    try { await onRemove(player.id) }
    finally { setRemoving(false) }
  }

  const posClass = position.toLowerCase()

  return (
    <div className="player-row">
      <div className="player-row-main">
        {/* Headshot */}
        {player.headshot_url
          ? <img src={player.headshot_url} alt="" className="player-headshot" onError={e => { e.target.style.display='none' }} />
          : <div className="player-headshot-placeholder">{POS_ICON[position]}</div>
        }

        {/* Name + meta */}
        <div className="player-info">
          <div className="player-name">{player.player_name}</div>
          <div className="player-meta">
            {player.nhl_team && <span className="player-team-badge">{player.nhl_team}</span>}
            <span className={`player-pos-badge ${posClass}`}>
              {position_detail || position}
            </span>
          </div>
        </div>

        {/* Stats mini (skaters only) */}
        {position !== 'G' && stats && (
          <div className="player-stats-mini">
            <div className="stat-mini">
              <div className="stat-mini-value">{stats.goals ?? 0}</div>
              <div className="stat-mini-label">G</div>
            </div>
            <div className="stat-mini">
              <div className="stat-mini-value">{stats.assists ?? 0}</div>
              <div className="stat-mini-label">A</div>
            </div>
            <div className="stat-mini">
              <div className="stat-mini-value">{stats.plusMinus ?? 0}</div>
              <div className="stat-mini-label">+/-</div>
            </div>
            <div className="stat-mini">
              <div className="stat-mini-value">{stats.penaltyMinutes ?? 0}</div>
              <div className="stat-mini-label">PIM</div>
            </div>
          </div>
        )}
        {position === 'G' && stats && (
          <div className="player-stats-mini">
            <div className="stat-mini">
              <div className="stat-mini-value">{stats.wins ?? 0}</div>
              <div className="stat-mini-label">W</div>
            </div>
            <div className="stat-mini">
              <div className="stat-mini-value">{stats.shutouts ?? 0}</div>
              <div className="stat-mini-label">SO</div>
            </div>
            <div className="stat-mini">
              <div className="stat-mini-value">{stats.goalsAgainstAverage?.toFixed(2) ?? '–'}</div>
              <div className="stat-mini-label">GAA</div>
            </div>
            <div className="stat-mini">
              <div className="stat-mini-value">{stats.savePct ? (stats.savePct * 1).toFixed(3) : '–'}</div>
              <div className="stat-mini-label">SV%</div>
            </div>
          </div>
        )}

        {/* Points + actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div>
            {stats ? (
              <>
                <div className="player-points-badge">{points}</div>
                {stats && (
                  <button className="breakdown-toggle" onClick={() => setShowBreakdown(s => !s)}>
                    {showBreakdown ? '▲' : '▼'} pts
                  </button>
                )}
              </>
            ) : (
              <span className="no-stats-msg">No data</span>
            )}
          </div>
          <button
            className="btn btn-icon btn-danger"
            onClick={handleRemove}
            disabled={removing}
            title="Remove player"
          >
            {removing ? <span className="loading-spinner" style={{ width: 12, height: 12 }}></span> : '×'}
          </button>
        </div>
      </div>

      {/* Breakdown panel */}
      {showBreakdown && stats && (
        <div className="breakdown-panel">
          {position !== 'G' ? (
            <>
              <div className="breakdown-item">
                <div className="breakdown-value">{breakdown.goalPoints ?? 0}</div>
                <div className="breakdown-label">{stats.goals ?? 0}G × 2</div>
              </div>
              <div className="breakdown-item">
                <div className="breakdown-value">{breakdown.assistPoints ?? 0}</div>
                <div className="breakdown-label">{stats.assists ?? 0}A × 1</div>
              </div>
              <div className="breakdown-item">
                <div className="breakdown-value">{breakdown.stPoints ?? 0}</div>
                <div className="breakdown-label">
                  {((stats.ppGoals ?? 0) + (stats.ppAssists ?? 0) + (stats.shGoals ?? 0) + (stats.shAssists ?? 0))} ST pts
                </div>
              </div>
              <div className="breakdown-item">
                <div className="breakdown-value">{breakdown.pimPoints ?? 0}</div>
                <div className="breakdown-label">{stats.penaltyMinutes ?? 0} PIM × 0.5</div>
              </div>
              <div className="breakdown-item">
                <div className={`breakdown-value ${(breakdown.pmPoints ?? 0) > 0 ? 'positive' : (breakdown.pmPoints ?? 0) < 0 ? 'negative' : ''}`}>
                  {(breakdown.pmPoints ?? 0) > 0 ? '+' : ''}{breakdown.pmPoints ?? 0}
                </div>
                <div className="breakdown-label">+/- ({stats.plusMinus ?? 0})</div>
              </div>
            </>
          ) : (
            <>
              <div className="breakdown-item">
                <div className="breakdown-value">{breakdown.winsPoints ?? 0}</div>
                <div className="breakdown-label">{stats.wins ?? 0}W × 2</div>
              </div>
              <div className="breakdown-item">
                <div className="breakdown-value">{breakdown.shutoutPoints ?? 0}</div>
                <div className="breakdown-label">{stats.shutouts ?? 0} SO × 3</div>
              </div>
              <div className="breakdown-item">
                <div className="breakdown-value">{breakdown.gaaRank ?? 0}</div>
                <div className="breakdown-label">GAA Rank ({stats.goalsAgainstAverage?.toFixed(2)})</div>
              </div>
              <div className="breakdown-item">
                <div className="breakdown-value">{breakdown.svpRank ?? 0}</div>
                <div className="breakdown-label">SV% Rank ({stats.savePct?.toFixed(3)})</div>
              </div>
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
  const { id } = useParams()
  const navigate = useNavigate()
  const [teamData, setTeamData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAddPlayer, setShowAddPlayer] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [pendingAction, setPendingAction] = useState(null)

  const fetchTeam = useCallback(async () => {
    setLoading(true)
    try {
      // Fetch standings to get stats-enriched player data
      const standingsData = await api.getStandings()
      const found = standingsData.standings?.find(t => t.id === parseInt(id))
      if (found) {
        setTeamData({ team: found, poolGoalieCount: standingsData.poolGoalieCount })
      } else {
        setError('Team not found')
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { fetchTeam() }, [fetchTeam])

  function withAuth(action) {
    setPendingAction(() => action)
    action().catch(err => {
      if (err.unauthorized) setShowPassword(true)
    })
  }

  async function handleRemovePlayer(rowId) {
    await api.removePlayer(id, rowId)
    await fetchTeam()
  }

  async function handleDeleteTeam() {
    if (!confirm(`Delete team "${teamData?.team?.name}"? This cannot be undone.`)) return
    setDeleting(true)
    try {
      await api.deleteTeam(id)
      navigate('/')
    } catch (err) {
      if (err.unauthorized) { setShowPassword(true); setPendingAction(() => handleDeleteTeam) }
      else setError(err.message)
      setDeleting(false)
    }
  }

  if (loading) return (
    <div className="loading-state">
      <span className="loading-spinner"></span> Loading team...
    </div>
  )

  if (error) return (
    <div>
      <Link to="/" className="back-link">← Back to Standings</Link>
      <div className="alert alert-error">{error}</div>
    </div>
  )

  const { team } = teamData
  const forwards = team.players.filter(p => p.position === 'F')
  const defensemen = team.players.filter(p => p.position === 'D')
  const goalies = team.players.filter(p => p.position === 'G')
  const roster = team.players
  const existingPlayerIds = new Set(roster.map(p => p.player_id))

  const sections = [
    { key: 'F', label: 'Forwards', players: forwards, max: 10 },
    { key: 'D', label: 'Defensemen', players: defensemen, max: 5 },
    { key: 'G', label: 'Goalies', players: goalies, max: 3 }
  ]

  return (
    <div>
      <Link to="/" className="back-link">← Back to Standings</Link>

      <div className="team-detail-header">
        <div>
          <div className="team-detail-name">{team.name}</div>
          {team.owner && <div className="team-detail-owner">Owner: {team.owner}</div>}
          <div className="team-roster-summary" style={{ marginTop: 8 }}>
            <span className="roster-pill f">{forwards.length}/10 F</span>
            <span className="roster-pill d">{defensemen.length}/5 D</span>
            <span className="roster-pill g">{goalies.length}/3 G</span>
          </div>
        </div>
        <div>
          <div className="team-total-points">
            <div className="team-total-value">{team.totalPoints}</div>
            <div className="team-total-label">Fantasy Points</div>
          </div>
        </div>
      </div>

      <div className="page-header">
        <div></div>
        <div className="header-actions">
          <button
            className="btn btn-danger btn-sm"
            onClick={handleDeleteTeam}
            disabled={deleting}
          >
            {deleting ? 'Deleting...' : 'Delete Team'}
          </button>
          <button className="btn btn-primary" onClick={() => withAuth(() => Promise.resolve(setShowAddPlayer(true)))}>
            + Add Player
          </button>
        </div>
      </div>

      {sections.map(({ key, label, players, max }) => (
        <div key={key} className="roster-section">
          <div className="roster-section-header">
            <div className={`section-title ${POS_CLASS[key]}`}>
              {POS_ICON[key]} {label}
              <span className="section-count">{players.length}/{max}</span>
            </div>
          </div>

          {players.length === 0 ? (
            <div style={{ color: 'var(--text-dim)', fontSize: 13, padding: '8px 4px' }}>
              No {label.toLowerCase()} added yet
            </div>
          ) : (
            players.map(player => (
              <PlayerRow
                key={player.id}
                player={player}
                onRemove={handleRemovePlayer}
              />
            ))
          )}
        </div>
      ))}

      {showAddPlayer && (
        <AddPlayerModal
          teamId={id}
          existingPlayerIds={existingPlayerIds}
          roster={roster}
          onClose={() => setShowAddPlayer(false)}
          onAdded={() => { setShowAddPlayer(false); fetchTeam() }}
        />
      )}

      {showPassword && (
        <PasswordModal
          onSuccess={() => { setShowPassword(false); if (pendingAction) pendingAction() }}
          onClose={() => setShowPassword(false)}
        />
      )}
    </div>
  )
}
