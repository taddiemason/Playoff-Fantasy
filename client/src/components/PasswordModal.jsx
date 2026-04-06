import { useState } from 'react'
import { savePassword } from '../api.js'

export default function PasswordModal({ onSuccess, onClose }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')

  function handleSubmit(e) {
    e.preventDefault()
    if (!value.trim()) { setError('Password required'); return }
    savePassword(value.trim())
    onSuccess()
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">Admin Password Required</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="alert alert-error">{error}</div>}
            <div className="form-group">
              <label className="form-label">Password</label>
              <input
                className="form-input"
                type="password"
                placeholder="Enter password to make changes"
                value={value}
                onChange={e => setValue(e.target.value)}
                autoFocus
              />
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">Unlock</button>
          </div>
        </form>
      </div>
    </div>
  )
}
