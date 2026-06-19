import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.jsx'
import Avatar from './Avatar.jsx'

export default function Navbar() {
  const { user, loading, logout } = useAuth()
  const navigate = useNavigate()

  async function handleLogout() {
    await logout()
    navigate('/')
  }

  return (
    <nav className="navbar">
      <div className="navbar-inner">
        <Link to="/" className="navbar-logo">
          SHLOB Playoff Hockey
        </Link>
        <div className="navbar-spacer" />
        {loading ? null : user ? (
          <div className="navbar-user">
            <Link to="/dashboard" className="btn btn-ghost btn-sm">My Leagues</Link>
            <Link to="/settings" className="navbar-user-link">
              <Avatar user={user} size={28} />
              <span>{user.username}</span>
            </Link>
            <button className="btn btn-ghost btn-sm" onClick={handleLogout}>Log out</button>
          </div>
        ) : (
          <div className="navbar-links">
            <Link to="/login" className="btn btn-ghost btn-sm">Log in</Link>
            <Link to="/register" className="btn btn-primary btn-sm">Sign up</Link>
          </div>
        )}
      </div>
    </nav>
  )
}
