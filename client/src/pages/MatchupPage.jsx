// client/src/pages/MatchupPage.jsx
import { useState, useEffect } from 'react'
import { useParams, useOutletContext } from 'react-router-dom'
import { api } from '../api.js'

export default function MatchupPage() {
  const { leagueId } = useParams()
  const { league }   = useOutletContext()
  const [data, setData]         = useState(null)
  const [loading, setLoading]   = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError]       = useState('')

  useEffect(() => {
    api.leagues.matchup.current(leagueId)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [leagueId])

  async function refresh() {
    setRefreshing(true)
    try {
      await api.leagues.matchup.score(leagueId)
      const d = await api.leagues.matchup.current(leagueId)
      setData(d)
    } catch (e) {
      setError(e.message)
    } finally {
      setRefreshing(false)
    }
  }

  if (loading) return <div className="loading-state"><span className="loading-spinner" /> Loading matchup…</div>
  if (error)   return <div className="alert alert-error">{error}</div>
  if (!data?.period) {
    return <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>No active matchup this week.</div>
  }
  if (!data?.matchup) {
    return <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>No matchup assigned for your team this week.</div>
  }

  const { period, matchup, myTeam, oppTeam, oppPlayers } = data
  const myIsHome = matchup.home_team_id === myTeam?.id
  const myScore  = myIsHome ? matchup.home_score : matchup.away_score
  const oppScore = myIsHome ? matchup.away_score : matchup.home_score
  const winning  = myScore > oppScore
  const tied     = myScore === oppScore

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '1rem' }}>
        <h1 className="page-title" style={{ margin: 0 }}>Week {period.period_num} Matchup</h1>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          {period.start_date} – {period.end_date}
        </span>
      </div>

      {/* Scoreboard */}
      <div className="card" style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'center', padding: '2rem', marginBottom: '1.5rem' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>You</div>
          <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{myTeam?.name}</div>
          <div style={{ fontSize: '2.5rem', fontWeight: 700, color: winning ? 'var(--accent)' : 'var(--text)' }}>
            {myScore.toFixed(1)}
          </div>
        </div>
        <div style={{ fontSize: '1.25rem', color: 'var(--text-muted)', fontWeight: 600 }}>vs</div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Opponent</div>
          <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{oppTeam?.name}</div>
          <div style={{ fontSize: '2.5rem', fontWeight: 700, color: !winning && !tied ? 'var(--accent)' : 'var(--text)' }}>
            {oppScore.toFixed(1)}
          </div>
        </div>
      </div>

      {/* Status */}
      <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        {tied
          ? <span className="badge">Tied</span>
          : winning
            ? <span className="badge" style={{ background: 'var(--accent)' }}>You're winning</span>
            : <span className="badge" style={{ background: 'var(--text-muted)' }}>Opponent is winning</span>
        }
        <button onClick={refresh} disabled={refreshing} className="btn btn-ghost" style={{ marginLeft: '0.75rem', fontSize: '0.85rem' }}>
          {refreshing ? 'Updating…' : 'Refresh Scores'}
        </button>
      </div>

      {/* Opponent roster */}
      <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Opponent Roster</h2>
      <div className="card">
        {(oppPlayers || []).map(p => (
          <div key={p.player_id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.4rem 0', borderTop: '1px solid var(--border)' }}>
            {p.headshot_url && <img src={p.headshot_url} alt="" style={{ width: 32, height: 32, borderRadius: '50%' }} />}
            <span style={{ flex: 1 }}>{p.player_name}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{p.nhl_team} · {p.position}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
