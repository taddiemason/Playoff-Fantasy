import { useState } from 'react'
import { api } from '../api.js'

export default function AddTeamModal({ onClose, onCreated }) {
  const [name, setName] = useState('')
  const [owner, setOwner] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim()) { setError('Team name is required'); return }
    setLoading(true)
    setError('')
    try {
      const team = await api.createTeam(name.trim(), owner.trim())
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
