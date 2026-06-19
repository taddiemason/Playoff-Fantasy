import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../auth/AuthContext.jsx'

function LeagueCard({ league }) {
  return (
    <Link to={`/leagues/${league.id}`} className="league-card card">
      <div className="league-card-body">
        <div className="league-card-name">{league.name}</div>
        <div className="league-card-meta">
          <span className={`role-badge ${league.role === 'commissioner' ? 'commish' : ''}`}>
            {league.role === 'commissioner' ? 'Commissioner' : 'Member'}
          </span>
          <span>{league.teamCount ?? 0} teams</span>
          <span>{league.memberCount ?? 0} members</span>
        </div>
      </div>
      <div className="league-card-arrow">→</div>
    </Link>
  )
}

export default function Dashboard() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [joinCode, setJoinCode] = useState('')

  useEffect(() => {
    api.leagues.mine()
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  function handleJoin(e) {
    e.preventDefault()
    const code = joinCode.trim()
    if (code) navigate(`/join/${encodeURIComponent(code)}`)
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">My Leagues</div>
          <div className="page-subtitle">Welcome back, {user.username}</div>
        </div>
        <div className="header-actions">
          <form className="join-inline" onSubmit={handleJoin}>
            <input className="form-input" placeholder="Invite code" value={joinCode} onChange={(e) => setJoinCode(e.target.value)} style={{ width: 130 }} />
            <button className="btn btn-ghost" type="submit">Join</button>
          </form>
          <Link to="/leagues/new" className="btn btn-primary">+ Create League</Link>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <div className="loading-state"><span className="loading-spinner"></span> Loading…</div>
      ) : (
        <>
          {data?.invites?.length > 0 && (
            <>
              <div className="dashboard-section-title">Pending invites</div>
              <div className="league-list">
                {data.invites.map((inv) => (
                  <div className="league-card" key={inv.code} onClick={() => navigate(`/join/${inv.code}`)}>
                    <div className="league-card-body">
                      <div className="league-card-name">{inv.leagueName}</div>
                      <div className="league-card-meta"><span>You’ve been invited — click to join</span></div>
                    </div>
                    <div className="league-card-arrow">→</div>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="dashboard-section-title">Leagues you own</div>
          {data?.owned?.length ? (
            <div className="league-list">
              {data.owned.map((l) => <LeagueCard key={l.id} league={l} />)}
            </div>
          ) : (
            <div className="empty-state-inline">You don’t own any leagues yet. Create one to get started.</div>
          )}

          <div className="dashboard-section-title">Leagues you joined</div>
          {data?.joined?.length ? (
            <div className="league-list">
              {data.joined.map((l) => <LeagueCard key={l.id} league={l} />)}
            </div>
          ) : (
            <div className="empty-state-inline">You haven’t joined any leagues yet. Ask a commissioner for an invite code.</div>
          )}
        </>
      )}
    </div>
  )
}
