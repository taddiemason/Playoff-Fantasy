import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { api } from '../api.js'

export default function CreateLeague() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [seasonType, setSeasonType] = useState('playoffs')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim()) { setError('League name is required'); return }
    setError('')
    setSubmitting(true)
    try {
      const league = await api.leagues.create(name.trim(), seasonType)
      navigate(`/leagues/${league.id}`)
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <Link to="/dashboard" className="back-link">&#8592; Back to Dashboard</Link>
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="auth-title">Create a League</div>
          <div className="auth-subtitle">{"You'll be the commissioner. You can invite players and set rules next."}</div>
          <form onSubmit={handleSubmit}>
            {error && <div className="alert alert-error">{error}</div>}
            <div className="form-group">
              <label className="form-label">League Name</label>
              <input
                className="form-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. The Office Playoff Pool"
                maxLength={60}
                autoFocus
              />
            </div>
            <div className="form-group">
              <label className="form-label">Season Type</label>
              <select
                className="form-input"
                value={seasonType}
                onChange={(e) => setSeasonType(e.target.value)}
              >
                <option value="playoffs">NHL Playoffs</option>
                <option value="regular">Regular Season</option>
              </select>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                {seasonType === 'regular'
                  ? 'Scores regular-season stats (Oct-Apr). Rosters can be changed at any time.'
                  : 'Scores playoff stats only. Rosters are typically locked once the bracket is set.'}
              </div>
            </div>
            <button className="btn btn-primary auth-submit" type="submit" disabled={submitting}>
              {submitting ? <><span className="loading-spinner"></span> Creating...</> : 'Create League'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}