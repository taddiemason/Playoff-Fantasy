import { useEffect, useState, useCallback } from 'react'
import { useParams, Outlet, Navigate, useLocation, Link, NavLink } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../auth/AuthContext.jsx'

function LeagueNav({ leagueId, isCommissioner }) {
  const tab = ({ isActive }) => `league-tab${isActive ? ' active' : ''}`
  return (
    <div className="league-nav">
      <NavLink end to={`/leagues/${leagueId}`} className={tab}>Home</NavLink>
      <NavLink to={`/leagues/${leagueId}/standings`} className={tab}>Standings</NavLink>
      <NavLink to={`/leagues/${leagueId}/matchup`} className={tab}>Matchup</NavLink>
      <NavLink to={`/leagues/${leagueId}/lineup`} className={tab}>Lineup</NavLink>
      <NavLink to={`/leagues/${leagueId}/schedule`} className={tab}>Schedule</NavLink>
      <NavLink to={`/leagues/${leagueId}/waivers`} className={tab}>Waivers</NavLink>
      <NavLink to={`/leagues/${leagueId}/trades`} className={tab}>Trades</NavLink>
      <NavLink to={`/leagues/${leagueId}/rules`} className={tab}>Rules</NavLink>
      <NavLink to={`/leagues/${leagueId}/players`} className={tab}>Players</NavLink>
      <NavLink to={`/leagues/${leagueId}/add-players`} className={tab}>Add Players</NavLink>
      {isCommissioner && <NavLink to={`/leagues/${leagueId}/admin`} className={tab}>Manage</NavLink>}
    </div>
  )
}

// Loads the league for /leagues/:leagueId/* routes, enforces membership, and
// exposes { league, refreshLeague } to child routes via Outlet context.
export default function LeagueLayout() {
  const { leagueId } = useParams()
  const { user, loading: authLoading } = useAuth()
  const location = useLocation()
  const [league, setLeague] = useState(null)
  const [status, setStatus] = useState('loading') // loading | ok | error
  const [errorMsg, setErrorMsg] = useState('')

  const refreshLeague = useCallback(async () => {
    try {
      const lg = await api.leagues.get(leagueId)
      setLeague(lg)
      setStatus('ok')
    } catch (err) {
      setErrorMsg(err.message || 'Could not load league')
      setStatus('error')
    }
  }, [leagueId])

  useEffect(() => { if (user) refreshLeague() }, [user, refreshLeague])

  if (authLoading || (user && status === 'loading')) {
    return <div className="loading-state"><span className="loading-spinner"></span> Loading league…</div>
  }
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />
  if (status === 'error') {
    return (
      <div>
        <Link to="/dashboard" className="back-link">← Back to Dashboard</Link>
        <div className="alert alert-error">{errorMsg}</div>
      </div>
    )
  }
  return (
    <div>
      <LeagueNav leagueId={leagueId} isCommissioner={league?.role === 'commissioner'} />
      <Outlet context={{ league, refreshLeague }} />
    </div>
  )
}
