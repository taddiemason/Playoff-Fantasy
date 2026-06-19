import { useState } from 'react'
import { api } from '../api.js'
import { useAuth } from '../auth/AuthContext.jsx'

function validateTiebreaker(val) {
  if (!val.trim()) return null
  const n = parseFloat(val)
  if (isNaN(n) || n < 0 || n > 1) return 'Must be a decimal between 0 and 1 (e.g. .9145)'
  if (!/^\d*\.\d{1,4}$/.test(val.trim())) return 'Must have up to 4 decimal places (e.g. .9145)'
  return null
}

export default function AddTeamModal({ leagueId, onClose, onCreated }) {
  const { user } = useAuth()
  const [name, setName] = useState('')
  const [owner, setOwner] = useState(user?.username || '')
  const [tiebreaker, setTiebreaker] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim()) { setError('Team name is required'); return }
    const tbErr = validateTiebreaker(tiebreaker)
    if (tbErr) { setError(tbErr); return }
    setLoading(true)
    setError('')
    try {
      const team = await api.leagues.createTeam(leagueId, name.trim(), owner.trim(), tiebreaker.trim() || null)
      onCreated(team)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">Add New Team</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="alert alert-error">{error}</div>}
            <div className="form-group">
              <label className="form-label">Team Name *</label>
              <input
                className="form-input"
                placeholder="e.g. The Mighty Ducks"
                value={name}
                onChange={e => setName(e.target.value)}
                autoFocus
                maxLength={50}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Owner Name</label>
              <input
                className="form-input"
                placeholder="e.g. John Smith"
                value={owner}
                onChange={e => setOwner(e.target.value)}
                maxLength={50}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Tiebreaker — Stanley Cup Winning Goalie SV%</label>
              <input
                className="form-input"
                placeholder="e.g. .9145"
                value={tiebreaker}
                onChange={e => setTiebreaker(e.target.value)}
                maxLength={6}
              />
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Guess the playoff SV% of the Stanley Cup winning goalie to 4 decimal places.
                Used to break ties in final standings.
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? <><span className="loading-spinner"></span> Creating...</> : 'Create Team'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
