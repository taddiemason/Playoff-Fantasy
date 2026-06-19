import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.jsx'

const FEATURES = [
  { title: 'Create or join leagues', desc: 'Spin up your own pool or join friends with an invite code.' },
  { title: 'No draft, all chaos', desc: 'Build any roster you want — once a player’s team is out, that spot is dead.' },
  { title: 'Live playoff scoring', desc: 'Stats pull straight from the NHL, standings update through every round.' },
  { title: 'Commissioner controls', desc: 'Lock rosters, set payouts, manage members, and run your league your way.' },
]

export default function Landing() {
  const { user } = useAuth()
  return (
    <div className="landing">
      <section className="landing-hero">
        <h1 className="landing-title">Playoff Fantasy Hockey</h1>
        <p className="landing-tagline">
          Pick your guys. Trust your gut. Survive the chaos.<br />
          See who actually knows playoff hockey.
        </p>
        <div className="landing-cta">
          {user ? (
            <Link to="/" className="btn btn-primary">Go to Standings</Link>
          ) : (
            <>
              <Link to="/register" className="btn btn-primary">Get Started</Link>
              <Link to="/login" className="btn btn-ghost">Log In</Link>
            </>
          )}
        </div>
      </section>

      <section className="landing-features">
        {FEATURES.map((f) => (
          <div key={f.title} className="landing-feature card">
            <div className="landing-feature-title">{f.title}</div>
            <div className="landing-feature-desc">{f.desc}</div>
          </div>
        ))}
      </section>
    </div>
  )
}
