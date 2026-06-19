import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { api } from '../api.js'

export default function CreateLeague() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim()) { setError('League name is required'); return }
    setError('')
    setSubmitting(true)
    try {
      const league = await api.leagues.create(name.trim())
      navigate(`/leagues/${league.id}`)
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <Link to="/dashboard" className="back-link">← Back to Dashboard</Link>
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="auth-title">Create a League</div>
          <div className="auth-subtitle">You’ll be the commissioner. You can invite players and set rules next.</div>
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
            <button className="btn btn-primary auth-submit" type="submit" disabled={submitting}>
              {submitting ? <><span className="loading-spinner"></span> Creating…</> : 'Create League'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
