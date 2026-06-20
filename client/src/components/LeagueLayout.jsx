import { useEffect, useState, useCallback } from 'react'
import { useParams, Outlet, Navigate, useLocation, Link, NavLink } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../auth/AuthContext.jsx'

const PHASE_MESSAGES = {
  offseason: 'Season ended — waiting for the commissioner to start the next season.',
  keeper_window: 'Keeper window is open — designate your keepers before the commissioner closes it.',
  supplemental_draft: 'Supplemental draft in progress.',
  pre_draft: 'Season starting soon — finalize your roster.',
};

export default function LeagueLayout() {
  const { leagueId } = useParams()
  const { user, loading: authLoading } = useAuth()
  const location = useLocation()
  const [league, setLeague] = useState(null)
  const [status, setStatus] = useState('loading')
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

  const tab = (isActive) => `league-tab${isActive ? ' active' : ''}`
  const isCommissioner = league?.role === 'commissioner'
  const showKeepers = league?.league_format && league.league_format !== 'redraft'
  const phaseMsg = league?.phase && league.phase !== 'active' ? PHASE_MESSAGES[league.phase] : null

  return (
    <div>
      <div className="league-nav">
        <NavLink end to={`/leagues/${leagueId}`} className={({ isActive }) => tab(isActive)}>Home</NavLink>
        <NavLink to={`/leagues/${leagueId}/standings`} className={({ isActive }) => tab(isActive)}>Standings</NavLink>
        <NavLink to={`/leagues/${leagueId}/matchup`} className={({ isActive }) => tab(isActive)}>Matchup</NavLink>
        <NavLink to={`/leagues/${leagueId}/lineup`} className={({ isActive }) => tab(isActive)}>Lineup</NavLink>
        <NavLink to={`/leagues/${leagueId}/schedule`} className={({ isActive }) => tab(isActive)}>Schedule</NavLink>
        <NavLink to={`/leagues/${leagueId}/waivers`} className={({ isActive }) => tab(isActive)}>Waivers</NavLink>
        <NavLink to={`/leagues/${leagueId}/trades`} className={({ isActive }) => tab(isActive)}>Trades</NavLink>
        <NavLink to={`/leagues/${leagueId}/draft`} className={({ isActive }) => tab(isActive)}>Draft</NavLink>
        <NavLink to={`/leagues/${leagueId}/auction`} className={({ isActive }) => tab(isActive)}>Auction</NavLink>
        {showKeepers && (
          <NavLink to={`/leagues/${leagueId}/keepers`} className={({ isActive }) => tab(isActive)}>Keepers</NavLink>
        )}
        <NavLink to={`/leagues/${leagueId}/rules`} className={({ isActive }) => tab(isActive)}>Rules</NavLink>
        <NavLink to={`/leagues/${leagueId}/players`} className={({ isActive }) => tab(isActive)}>Players</NavLink>
        <NavLink to={`/leagues/${leagueId}/add-players`} className={({ isActive }) => tab(isActive)}>Add Players</NavLink>
        {isCommissioner && <NavLink to={`/leagues/${leagueId}/admin`} className={({ isActive }) => tab(isActive)}>Manage</NavLink>}
      </div>
      {phaseMsg && (
        <div style={{ background: '#2c3e50', borderBottom: '1px solid #34495e', padding: '8px 16px', fontSize: '0.85rem', color: '#bdc3c7' }}>
          {phaseMsg}
        </div>
      )}
      <Outlet context={{ league, refreshLeague }} />
    </div>
  )
}
