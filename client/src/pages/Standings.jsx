import { useState, useEffect, useCallback } from 'react'
import { useParams, useOutletContext, useNavigate, Link } from 'react-router-dom'
import { api } from '../api.js'
import SwipeStandings from '../components/SwipeStandings.jsx'

function Movement({ delta }) {
  if (delta == null) return <span className="move move-flat">–</span>
  if (delta > 0) return <span className="move move-up">▲{delta}</span>
  if (delta < 0) return <span className="move move-down">▼{Math.abs(delta)}</span>
  return <span className="move move-flat">–</span>
}

export default function Standings() {
  const { leagueId } = useParams()
  const { league } = useOutletContext()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [movement, setMovement] = useState({})

  const fetchStandings = useCallback(async () => {
    try {
      const d = await api.leagues.getStandings(leagueId)
      setData(d)
      setError(d.stale ? `Showing cached stats (${d.error})` : d.error ? `NHL API: ${d.error}` : '')

      // Movement vs the ranking last seen on this device.
      const key = `ranks_${leagueId}`
      let prev = {}
      try { prev = JSON.parse(localStorage.getItem(key) || '{}') } catch { prev = {} }
      const move = {}
      const current = {}
      ;(d.standings || []).forEach((t, i) => {
        const rank = i + 1
        current[t.id] = rank
        move[t.id] = prev[t.id] != null ? prev[t.id] - rank : null
      })
      setMovement(move)
      localStorage.setItem(key, JSON.stringify(current))
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

  if (loading) return <div className="loading-state"><span className="loading-spinner"></span> Loading standings…</div>

  const eliminatedSet = new Set((data?.eliminatedTeams || []).map((t) => (t || '').trim().toUpperCase()))

  const rows = (data?.standings || []).map((team) => {
    let skaterPts = 0, goaliePts = 0, active = 0, dead = 0
    for (const p of team.players) {
      if (p.position === 'G') goaliePts += p.points || 0
      else skaterPts += p.points || 0
      if (eliminatedSet.has((p.nhl_team || '').trim().toUpperCase())) dead++
      else active++
    }
    return {
      ...team,
      skaterPts: Math.round(skaterPts * 10) / 10,
      goaliePts: Math.round(goaliePts * 10) / 10,
      active,
      dead,
      total: team.players.length,
    }
  })

  return (
    <div>
      <Link to={`/leagues/${leagueId}`} className="back-link">← {league.name}</Link>
      <div className="page-header">
        <div>
          <div className="page-title">Live Standings</div>
          {data?.lastUpdated && (
            <div className="page-subtitle">Updated {new Date(data.lastUpdated).toLocaleTimeString()} · movement since your last visit</div>
          )}
        </div>
        <div className="header-actions">
          <button className="btn btn-ghost" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? <><span className="loading-spinner"></span> Refreshing…</> : '↻ Refresh Stats'}
          </button>
        </div>
      </div>

      {error && <div className="alert alert-warn">{error}</div>}

      {rows.length === 0 ? (
        <div className="empty-state"><div className="empty-state-title">No teams yet</div></div>
      ) : (
        <>
        <div className="mobile-only">
          <SwipeStandings rows={rows} leagueId={leagueId} />
        </div>
        <div className="standings-table desktop-only">
          <div className="st-row st-head">
            <div className="st-rank">#</div>
            <div className="st-team">Team</div>
            <div className="st-num">W</div>
            <div className="st-num">L</div>
            <div className="st-num">T</div>
            <div className="st-num">Active</div>
            <div className="st-num">Dead</div>
            <div className="st-num">Skater</div>
            <div className="st-num">Goalie</div>
            <div className="st-num st-total">Total</div>
          </div>
          {rows.map((t, i) => (
            <div key={t.id} className={`st-row st-data rank-${i + 1 <= 3 ? i + 1 : 'n'}`} onClick={() => navigate(`/leagues/${leagueId}/teams/${t.id}`)}>
              <div className="st-rank">
                <span className="st-rank-num">{i + 1}</span>
                <Movement delta={movement[t.id]} />
              </div>
              <div className="st-team">
                <div className="st-team-name">{t.name}</div>
                {t.owner && <div className="st-team-owner">{t.owner}</div>}
              </div>
              <div className="st-num" style={{ fontWeight: 600, color: 'var(--accent)' }}>{t.wins ?? 0}</div>
              <div className="st-num st-dim">{t.losses ?? 0}</div>
              <div className="st-num st-dim">{t.ties ?? 0}</div>
              <div className={`st-num ${t.active === 0 && t.total > 0 ? 'st-danger' : ''}`}>{t.active}/{t.total}</div>
              <div className={`st-num ${t.dead > 0 ? 'st-danger' : 'st-dim'}`}>{t.dead}</div>
              <div className="st-num">{t.skaterPts}</div>
              <div className="st-num">{t.goaliePts}</div>
              <div className="st-num st-total">{t.totalPoints}</div>
            </div>
          ))}
        </div>
        </>
      )}
    </div>
  )
}
