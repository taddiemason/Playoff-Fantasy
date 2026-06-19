import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.jsx'

export default function RequireAuth({ children }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="loading-state">
        <span className="loading-spinner"></span> Loading…
      </div>
    )
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  return children
}
