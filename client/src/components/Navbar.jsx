import { Link } from 'react-router-dom'

export default function Navbar() {
  return (
    <nav className="navbar">
      <div className="navbar-inner">
        <Link to="/" className="navbar-logo">
          SHLOB Playoff Hockey
        </Link>
      </div>
    </nav>
  )
}
