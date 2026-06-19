import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api } from '../api.js'

export default function SchedulePage() {
  const { leagueId } = useParams()
  const [data, setData]     = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState('')

  useEffect(() => {
    api.leagues.schedule.get(leagueId)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [leagueId])

  if (loading) return <div className="loading-state"><span className="loading-spinner" /> Loading schedule…</div>
  if (error)   return <div className="alert alert-error">{error}</div>
  if (!data?.periods?.length) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
        <p>No schedule yet.</p>
        <p><Link to={`/leagues/${leagueId}/admin`}>Commissioners can generate one here.</Link></p>
      </div>
    )
  }

  const matchupsByPeriod = new Map()
  for (const m of (data.matchups || [])) {
    const list = matchupsByPeriod.get(m.period_id) || []
    list.push(m)
    matchupsByPeriod.set(m.period_id, list)
  }

  return (
    <div>
      <h1 className="page-title">Schedule</h1>
      {data.periods.map(period => (
        <div key={period.id} className="card" style={{ marginBottom: '1rem' }}>
          <h3 style={{ margin: '0 0 0.5rem' }}>
            Week {period.period_num}
            <span className="badge" style={{ marginLeft: '0.5rem', fontSize: '0.75rem' }}>
              {period.start_date} – {period.end_date}
            </span>
          </h3>
          {(matchupsByPeriod.get(period.id) || []).map(m => (
            <div key={m.id} className="matchup-row" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.4rem 0', borderTop: '1px solid var(--border)' }}>
              <span style={{ flex: 1, textAlign: 'right' }}>{m.home_name}</span>
              <span style={{ fontWeight: 700, color: 'var(--accent)' }}>
                {m.home_score.toFixed(1)} – {m.away_score.toFixed(1)}
              </span>
              <span style={{ flex: 1 }}>{m.away_name}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
