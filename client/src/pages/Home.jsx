import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import AddTeamModal from '../components/AddTeamModal.jsx'
import PasswordModal from '../components/PasswordModal.jsx'

const MEDALS = ['1', '2', '3']

function LeagueDescription() {
  return (
    <div className="league-description">
      <p>There's still time for one more fantasy hockey league, let's run it.</p>
      <p>
        This is a playoff pool with <strong>NO draft</strong>. Build your roster with whoever you want,
        but choose wisely — once a player's team is knocked out, that roster spot is dead.
        No replacements. No resets. Same goes for injuries, suspensions, or anything else:
        once they're done, they're done.
      </p>
      <p>Lineups must be locked in before puck drop of Game 1. After that, the site password gets changed and all rosters are final.</p>
      <div className="payout-block">
        <div className="payout-title">Payout Structure</div>
        <div className="payout-row"><span className="payout-entries">6 or fewer entries</span><span className="payout-split">Winner takes all</span></div>
        <div className="payout-row"><span className="payout-entries">7 or more entries</span><span className="payout-split">75% to 1st · 25% to 2nd</span></div>
        <div className="payout-row"><span className="payout-entries">12 or more entries</span><span className="payout-split">60% to 1st · 25% to 2nd · 15% to 3rd</span></div>
      </div>
      <p className="league-tagline">Pick your guys. Trust your gut. Survive the chaos.<br />Let's see who actually knows playoff hockey.</p>
    </div>
  )
}

function ScoringRules() {
  const [open, setOpen] = useState(false)
  return (
    <div className="scoring-rules">
      <div className="scoring-rules-title" onClick={() => setOpen(o => !o)}>
        <span>Scoring Rules</span>
        <span>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div className="rules-grid">
          <div>
            <div className="rules-col-title">Skaters (F &amp; D)</div>
            <div className="rule-item"><span>Goal</span><span className="rule-pts">+2 pts</span></div>
            <div className="rule-item"><span>Assist</span><span className="rule-pts">+1 pt</span></div>
            <div className="rule-item"><span>Special Teams Point</span><span className="rule-pts">+1 pt (bonus)</span></div>
            <div className="rule-item"><span>Penalty Minute</span><span className="rule-pts">+0.5 pts</span></div>
            <div className="rule-item"><span>Plus/Minus</span><span className="rule-pts">actual value</span></div>
          </div>
          <div>
            <div className="rules-col-title">Goalies</div>
            <div className="rule-item"><span>Win</span><span className="rule-pts">+2 pts</span></div>
            <div className="rule-item"><span>Shutout</span><span className="rule-pts">+3 pts</span></div>
            <div className="rule-item"><span>GAA Rank</span><span className="rule-pts">ranked pts</span></div>
            <div className="rule-item"><span>SV% Rank</span><span className="rule-pts">ranked pts</span></div>
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Goalie ranking: best GAA/SV% among all goalies in the league pool.
              Best gets N pts, 2nd gets N-1, etc.
            </div>
          </div>
          <div>
            <div className="rules-col-title">Tiebreaker</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              If two teams are tied on points, the tiebreaker is the closest guess to the
              Stanley Cup winning goalie's total playoff save percentage (to 4 decimal places, e.g. .9145).
              Enter your guess on your team's page.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function Home() {
  const [standings, setStandings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [showAddTeam, setShowAddTeam] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [pendingAction, setPendingAction] = useState(null)
  const navigate = useNavigate()

  const fetchStandings = useCallback(async () => {
    try {
      const data = await api.getStandings()
      setStandings(data)
      setError(data.error ? `NHL API: ${data.error}` : '')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { fetchStandings() }, [fetchStandings])

  function withAuth(action) {
    if (!localStorage.getItem('shlob_password')) {
      setPendingAction(() => action)
      setShowPassword(true)
      return
    }
    action().catch(err => {
      if (err.unauthorized) {
        setPendingAction(() => action)
        setShowPassword(true)
      }
    })
  }

  async function handleRefresh() {
    setRefreshing(true)
    await api.refreshStats()
    await fetchStandings()
  }

  function handleTeamCreated(team) {
    setShowAddTeam(false)
    fetchStandings()
  }

  const seasonStr = standings?.season
    ? `${standings.season.slice(0, 4)}–${standings.season.slice(4)}`
    : ''

  return (
    <div>
      <LeagueDescription />
      <ScoringRules />

      <div className="page-header">
        <div>
          <div className="page-title">Standings</div>
          {seasonStr && (
            <div className="page-subtitle">
              {seasonStr} NHL Playoffs
              {standings?.lastUpdated && (
                <span className="last-updated"> · Updated {new Date(standings.lastUpdated).toLocaleTimeString()}</span>
              )}
            </div>
          )}
        </div>
        <div className="header-actions">
          <button className="btn btn-ghost" onClick={handleRefresh} disabled={refreshing || loading}>
            {refreshing ? <><span className="loading-spinner"></span> Refreshing...</> : '↻ Refresh Stats'}
          </button>
          <button className="btn btn-primary" onClick={() => withAuth(() => Promise.resolve(setShowAddTeam(true)))}>
            + Add Team
          </button>
        </div>
      </div>

      {error && (
        <div className="alert alert-warn" style={{ marginBottom: 16 }}>
          {error} — Showing roster data only. Stats will appear when playoffs begin.
        </div>
      )}

      {loading ? (
        <div className="loading-state">
          <span className="loading-spinner"></span>
          Loading standings...
        </div>
      ) : standings?.standings?.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"></div>
          <div className="empty-state-title">No teams yet</div>
          <div className="empty-state-desc">Add your first fantasy team to get started</div>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => withAuth(() => Promise.resolve(setShowAddTeam(true)))}>
            + Add Team
          </button>
        </div>
      ) : (
        <div className="standings-grid">
          {standings?.standings?.map((team, idx) => {
            const rank = idx + 1
            const rankClass = rank <= 3 ? `rank-${rank}` : ''
            const fwd = team.players.filter(p => p.position === 'F').length
            const def = team.players.filter(p => p.position === 'D').length
            const gol = team.players.filter(p => p.position === 'G').length

            return (
              <div
                key={team.id}
                className={`team-card ${rankClass}`}
                onClick={() => navigate(`/team/${team.id}`)}
              >
                <div className="team-rank">
                  {rank <= 3 ? MEDALS[rank - 1] : rank}
                </div>
                <div className="team-info">
                  <div className="team-name">{team.name}</div>
                  {team.owner && <div className="team-owner">{team.owner}</div>}
                  <div className="team-roster-summary">
                    {fwd > 0 && <span className="roster-pill f">{fwd}/10 F</span>}
                    {def > 0 && <span className="roster-pill d">{def}/5 D</span>}
                    {gol > 0 && <span className="roster-pill g">{gol}/3 G</span>}
                    {fwd === 0 && def === 0 && gol === 0 && (
                      <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>No players added</span>
                    )}
                  </div>
                  {team.tiebreaker && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                      TB: {team.tiebreaker}
                    </div>
                  )}
                </div>
                <div className="team-points">
                  <div className="points-value">{team.totalPoints}</div>
                  <div className="points-label">pts</div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showAddTeam && (
        <AddTeamModal
          onClose={() => setShowAddTeam(false)}
          onCreated={handleTeamCreated}
          onUnauthorized={() => { setShowAddTeam(false); setPendingAction(() => () => setShowAddTeam(true)); setShowPassword(true) }}
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
