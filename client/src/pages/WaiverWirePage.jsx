// client/src/pages/WaiverWirePage.jsx
import { useState, useEffect } from 'react'
import { useParams, useOutletContext } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.jsx'
import { api } from '../api.js'

export default function WaiverWirePage() {
  const { leagueId } = useParams()
  useOutletContext() // league available if needed
  const { user } = useAuth()
  const [data, setData] = useState(null)
  const [myPlayers, setMyPlayers] = useState([])
  const [claimTarget, setClaimTarget] = useState(null)
  const [dropPlayerId, setDropPlayerId] = useState('')
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(true)

  async function load() {
    const [w, teams, standingsData] = await Promise.all([
      api.leagues.waivers.list(leagueId),
      api.leagues.getTeams(leagueId),
      api.leagues.getStandings(leagueId),
    ])
    setData(w)
    const myTeam = teams.find(t => t.user_id === user?.id)
    if (myTeam) {
      const entry = (standingsData?.standings || []).find(s => s.id === myTeam.id)
      setMyPlayers(entry?.players || [])
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [leagueId])

  async function submitClaim() {
    try {
      await api.leagues.waivers.claim(leagueId, claimTarget.id, dropPlayerId ? parseInt(dropPlayerId) : null)
      setMsg('Claim submitted!')
      setClaimTarget(null)
      load()
    } catch (e) { setMsg(e.message) }
  }

  async function handlePickup(dp) {
    try {
      await api.leagues.waivers.pickup(leagueId, dp.id)
      setMsg(`Picked up ${dp.player_name}!`)
      load()
    } catch (e) { setMsg(e.message) }
  }

  async function cancelClaim(claimId) {
    try {
      await api.leagues.waivers.cancelClaim(leagueId, claimId)
      setMsg('Claim cancelled.')
      load()
    } catch (e) { setMsg(e.message) }
  }

  if (loading) return <div className="loading-state"><span className="loading-spinner" /> Loading waivers…</div>

  const waiverPlayers = (data?.players || []).filter(p => p.status === 'waivers')
  const freeAgents = (data?.players || []).filter(p => p.status === 'free_agent')

  return (
    <div className="page-container">
      <h2>Waiver Wire</h2>
      {msg && <div className="alert">{msg}</div>}

      {(data?.myClaims || []).length > 0 && (
        <section style={{ marginBottom: '1.5rem' }}>
          <h3>My Pending Claims</h3>
          {data.myClaims.map(c => (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
              <span>Claim #{c.id} — priority {c.priority_at_time}</span>
              <button onClick={() => cancelClaim(c.id)}>Cancel</button>
            </div>
          ))}
        </section>
      )}

      <section style={{ marginBottom: '1.5rem' }}>
        <h3>On Waivers</h3>
        {waiverPlayers.length === 0
          ? <p className="st-dim">No players on waivers.</p>
          : waiverPlayers.map(p => {
              const meta = JSON.parse(p.player_meta_json || '{}')
              return (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                  <div>
                    <div>{p.player_name} <span className="st-dim">({meta.position})</span></div>
                    <div className="st-dim" style={{ fontSize: '0.8rem' }}>Deadline: {new Date(p.waiver_deadline).toLocaleString()}</div>
                  </div>
                  <button onClick={() => { setClaimTarget(p); setDropPlayerId(''); setMsg('') }}>Claim</button>
                </div>
              )
            })
        }
      </section>

      <section>
        <h3>Free Agents</h3>
        {freeAgents.length === 0
          ? <p className="st-dim">No free agents available.</p>
          : freeAgents.map(p => {
              const meta = JSON.parse(p.player_meta_json || '{}')
              return (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                  <span>{p.player_name} <span className="st-dim">({meta.position})</span></span>
                  <button onClick={() => handlePickup(p)}>Pick Up</button>
                </div>
              )
            })
        }
      </section>

      {claimTarget && (
        <div className="modal-overlay">
          <div className="modal">
            <h3>Claim {claimTarget.player_name}</h3>
            <p>Optionally drop a player to make room:</p>
            <select value={dropPlayerId} onChange={e => setDropPlayerId(e.target.value)}>
              <option value="">— Keep roster as-is —</option>
              {myPlayers.map(p => (
                <option key={p.player_id} value={p.player_id}>{p.player_name}</option>
              ))}
            </select>
            {msg && <div className="alert alert-error" style={{ marginTop: '0.5rem' }}>{msg}</div>}
            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
              <button onClick={submitClaim}>Submit Claim</button>
              <button onClick={() => setClaimTarget(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
