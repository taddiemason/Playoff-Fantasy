import { useState, useEffect } from 'react'
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../auth/AuthContext.jsx'

export default function JoinLeague() {
  const { code } = useParams()
  const { user, loading: authLoading } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [preview, setPreview] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [joining, setJoining] = useState(false)

  useEffect(() => {
    api.invites.preview(code)
      .then(setPreview)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [code])

  async function handleJoin() {
    setJoining(true)
    setError('')
    try {
      const res = await api.invites.join(code)
      navigate(`/leagues/${res.league.id}`)
    } catch (err) {
      setError(err.message)
      setJoining(false)
    }
  }

  if (loading || authLoading) {
    return <div className="loading-state"><span className="loading-spinner"></span> Loading invite…</div>
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        {error && <div className="alert alert-error">{error}</div>}

        {!preview?.league ? (
          <>
            <div className="auth-title">Invite not found</div>
            <div className="auth-subtitle">This invite link is invalid or has been removed.</div>
            <Link to="/" className="btn btn-ghost auth-submit" style={{ marginTop: 8 }}>Go home</Link>
          </>
        ) : (
          <>
            <div className="auth-subtitle">You’ve been invited to join</div>
            <div className="auth-title">{preview.league.name}</div>
            <div className="auth-subtitle">{preview.league.memberCount} members</div>

            {!preview.valid && !preview.alreadyMember && (
              <div className="alert alert-warn" style={{ marginTop: 12 }}>This invite is no longer valid.</div>
            )}

            {!user ? (
              <div style={{ marginTop: 16 }}>
                <Link to="/login" state={{ from: location }} className="btn btn-primary auth-submit">Log in to join</Link>
                <div className="auth-footer">
                  New here? <Link to="/register" state={{ from: location }}>Create an account</Link>
                </div>
              </div>
            ) : preview.alreadyMember ? (
              <div style={{ marginTop: 16 }}>
                <div className="alert alert-info">You’re already in this league.</div>
                <Link to={`/leagues/${preview.league.id}`} className="btn btn-primary auth-submit">Go to league</Link>
              </div>
            ) : (
              <button className="btn btn-primary auth-submit" style={{ marginTop: 16 }} onClick={handleJoin} disabled={joining || !preview.valid}>
                {joining ? <><span className="loading-spinner"></span> Joining…</> : 'Join League'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
