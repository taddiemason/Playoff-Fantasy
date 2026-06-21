// client/src/pages/LineupPage.jsx
import { useState, useEffect, useCallback } from 'react'
import { useParams, useOutletContext, Link } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../auth/AuthContext.jsx'
import PlayerStatusBadge from '../components/PlayerStatusBadge.jsx'

const POS_LABEL = { F: 'Forwards', D: 'Defense', G: 'Goalies' }

export default function LineupPage() {
  const { leagueId }  = useParams()
  const { league }    = useOutletContext()
  const { user }      = useAuth()
  const [myTeam, setMyTeam]       = useState(null)
  const [periods, setPeriods]     = useState([])
  const [periodId, setPeriodId]   = useState(null)
  const [lineup, setLineup]       = useState(null)
  const [activeIds, setActiveIds] = useState(new Set())
  const [saving, setSaving]       = useState(false)
  const [msg, setMsg]             = useState(null)
  const [loading, setLoading]     = useState(true)

  useEffect(() => {
    Promise.all([
      api.leagues.getTeams(leagueId),
      api.leagues.schedule.get(leagueId),
    ]).then(([teams, sched]) => {
      const team = teams.find(t => t.user_id === user?.id) || teams[0]
      setMyTeam(team)
      setPeriods(sched.periods || [])
      const today = new Date().toISOString().slice(0, 10)
      const current = sched.periods.find(p => p.start_date <= today && p.end_date >= today)
      if (current) setPeriodId(current.id)
      else if (sched.periods.length) setPeriodId(sched.periods[0].id)
    }).catch(e => setMsg({ type: 'error', text: e.message }))
      .finally(() => setLoading(false))
  }, [leagueId])

  const fetchLineup = useCallback(() => {
    if (!myTeam || !periodId) return
    api.leagues.lineup.get(leagueId, myTeam.id, periodId)
      .then(data => {
        setLineup(data)
        setActiveIds(new Set(data.active.map(p => p.player_id)))
      })
      .catch(e => setMsg({ type: 'error', text: e.message }))
  }, [leagueId, myTeam, periodId])

  useEffect(() => { fetchLineup() }, [fetchLineup])

  function togglePlayer(playerId) {
    if (lineup?.locked) return
    setActiveIds(prev => {
      const next = new Set(prev)
      if (next.has(playerId)) next.delete(playerId)
      else next.add(playerId)
      return next
    })
  }

  async function saveLineup() {
    if (!myTeam || !periodId) return
    setSaving(true)
    setMsg(null)
    try {
      await api.leagues.lineup.set(leagueId, myTeam.id, periodId, [...activeIds])
      setMsg({ type: 'success', text: 'Lineup saved!' })
      fetchLineup()
    } catch (err) {
      setMsg({ type: 'error', text: err.message })
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="loading-state"><span className="loading-spinner" /> Loading lineup…</div>
  if (!periods.length) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
        <p>No schedule yet.</p>
        <Link to={`/leagues/${leagueId}/admin`}>Commissioners can generate one here.</Link>
      </div>
    )
  }

  const allPlayers = lineup ? [...(lineup.active || []), ...(lineup.bench || [])] : []
  const byPos = { F: [], D: [], G: [] }
  for (const p of allPlayers) byPos[p.position] = [...(byPos[p.position] || []), p]

  const slots = lineup?.slots || { F: 6, D: 3, G: 2 }
  const countByPos = { F: 0, D: 0, G: 0 }
  for (const pid of activeIds) {
    const p = allPlayers.find(pl => pl.player_id === pid)
    if (p) countByPos[p.position] = (countByPos[p.position] || 0) + 1
  }

  return (
    <div>
      <h1 className="page-title">Set Lineup</h1>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {periods.map(p => (
          <button
            key={p.id}
            onClick={() => setPeriodId(p.id)}
            className={`btn ${p.id === periodId ? 'btn-primary' : 'btn-ghost'}`}
            style={{ fontSize: '0.8rem', padding: '0.25rem 0.75rem' }}
          >
            Week {p.period_num}
          </button>
        ))}
      </div>

      {lineup?.locked && (
        <div className="alert" style={{ marginBottom: '1rem', background: 'var(--bg-card)', color: 'var(--text-muted)' }}>
          Lineup is locked for this week.
        </div>
      )}

      {['F', 'D', 'G'].map(pos => (
        <div key={pos} className="card" style={{ marginBottom: '1rem' }}>
          <h3 style={{ margin: '0 0 0.75rem' }}>
            {POS_LABEL[pos]}
            <span className="badge" style={{ marginLeft: '0.5rem', fontSize: '0.75rem' }}>
              {countByPos[pos] ?? 0} / {slots[pos]} active
            </span>
          </h3>
          {(byPos[pos] || []).map(p => {
            const isActive = activeIds.has(p.player_id)
            return (
              <div
                key={p.player_id}
                onClick={() => togglePlayer(p.player_id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.75rem',
                  padding: '0.5rem 0', borderTop: '1px solid var(--border)',
                  cursor: lineup?.locked ? 'default' : 'pointer',
                  opacity: lineup?.locked ? 0.7 : 1,
                }}
              >
                {p.headshot_url && <img src={p.headshot_url} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} />}
                <span style={{ flex: 1 }}>
                  <Link to={`/leagues/${leagueId}/players/${p.player_id}`} onClick={e => e.stopPropagation()}>{p.player_name}</Link>
                  {' '}<span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>({p.nhl_team})</span>
                  <PlayerStatusBadge injuryStatus={p.injuryStatus || ''} injuryDescription={p.injuryDescription || ''} />
                </span>
                <span style={{
                  padding: '0.2rem 0.6rem', borderRadius: 4, fontSize: '0.75rem', fontWeight: 600,
                  background: isActive ? 'var(--accent)' : 'var(--bg-input)',
                  color: isActive ? '#fff' : 'var(--text-muted)',
                }}>
                  {isActive ? 'Active' : 'Bench'}
                </span>
              </div>
            )
          })}
        </div>
      ))}

      {msg && <div className={`alert alert-${msg.type === 'success' ? 'success' : 'error'}`}>{msg.text}</div>}

      {!lineup?.locked && (
        <button onClick={saveLineup} disabled={saving} className="btn btn-primary" style={{ width: '100%' }}>
          {saving ? 'Saving…' : 'Save Lineup'}
        </button>
      )}
    </div>
  )
}
