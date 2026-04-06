import { Link } from 'react-router-dom'

export default function Navbar() {
  return (
    <nav className="navbar">
      <div className="navbar-inner">
        <Link to="/" className="navbar-logo">
          <span>🏒</span>
          Playoff Fantasy
          <span className="navbar-subtitle">Hockey</span>
        </Link>
      </div>
    </nav>
  )
}
