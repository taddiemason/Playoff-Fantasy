// client/src/pages/PlayerDetailPage.jsx
import { useState, useEffect } from 'react'
import { useParams, useOutletContext, Link } from 'react-router-dom'
import { api } from '../api.js'
import PlayerStatusBadge from '../components/PlayerStatusBadge.jsx'

function StatGrid({ position, featuredStats }) {
  const sub = featuredStats?.regularSeason?.subSeason
  if (!sub) return null
  const isGoalie = position === 'G'
  return (
    <div className="player-detail-stat-grid">
      <div className="stat-chip"><div className="stat-chip-value">{sub.gamesPlayed ?? '–'}</div><div className="stat-chip-label">GP</div></div>
      {isGoalie ? (
        <>
          <div className="stat-chip"><div className="stat-chip-value">{sub.wins ?? '–'}</div><div className="stat-chip-label">W</div></div>
          <div className="stat-chip"><div className="stat-chip-value">{sub.losses ?? '–'}</div><div className="stat-chip-label">L</div></div>
          <div className="stat-chip"><div className="stat-chip-value">{sub.goalsAgainstAverage?.toFixed(2) ?? '–'}</div><div className="stat-chip-label">GAA</div></div>
          <div className="stat-chip"><div className="stat-chip-value">{sub.savePctg ? sub.savePctg.toFixed(3) : '–'}</div><div className="stat-chip-label">SV%</div></div>
        </>
      ) : (
        <>
          <div className="stat-chip"><div className="stat-chip-value">{sub.goals ?? '–'}</div><div className="stat-chip-label">G</div></div>
          <div className="stat-chip"><div className="stat-chip-value">{sub.assists ?? '–'}</div><div className="stat-chip-label">A</div></div>
          <div className="stat-chip"><div className="stat-chip-value">{sub.points ?? '–'}</div><div className="stat-chip-label">PTS</div></div>
          <div className="stat-chip">
            <div className={`stat-chip-value ${(sub.plusMinus ?? 0) > 0 ? 'pm-positive' : (sub.plusMinus ?? 0) < 0 ? 'pm-negative' : ''}`}>
              {(sub.plusMinus ?? 0) > 0 ? '+' : ''}{sub.plusMinus ?? '–'}
            </div>
            <div className="stat-chip-label">+/-</div>
          </div>
        </>
      )}
    </div>
  )
}

function GameLogTable({ position, gameLog }) {
  if (!gameLog || !gameLog.length) return null
  const isGoalie = position === 'G'
  return (
    <div className="player-detail-section">
      <h3 className="player-detail-section-title">Recent Games</h3>
      <table className="player-detail-gamelog">
        <thead>
          <tr>
            <th>Date</th>
            <th>Opp</th>
            <th>H/A</th>
            {isGoalie ? (
              <>
                <th>Dec</th>
                <th>GAA</th>
                <th>SV%</th>
              </>
            ) : (
              <>
                <th>G</th>
                <th>A</th>
                <th>PTS</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {gameLog.map((g, i) => (
            <tr key={i}>
              <td>{g.gameDate || '–'}</td>
              <td>{g.opponentAbbrev || '–'}</td>
              <td>{g.homeRoadFlag || '–'}</td>
              {isGoalie ? (
                <>
                  <td>{g.decision || '–'}</td>
                  <td>{g.goalsAgainstAverage?.toFixed(2) ?? '–'}</td>
                  <td>{g.savePctg ? g.savePctg.toFixed(3) : '–'}</td>
                </>
              ) : (
                <>
                  <td>{g.goals ?? '–'}</td>
                  <td>{g.assists ?? '–'}</td>
                  <td>{g.points ?? '–'}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function NewsStories({ spotlightStories }) {
  if (!spotlightStories || !spotlightStories.length) return null
  return (
    <div className="player-detail-section">
      <h3 className="player-detail-section-title">News</h3>
      <div className="player-detail-news">
        {spotlightStories.map((s, i) => (
          <div key={i} className="player-detail-news-card">
            <div className="player-detail-news-title">{s.title}</div>
            <div className="player-detail-news-meta">
              {s.contributor && <span>{s.contributor}</span>}
              {s.date && <span> · {s.date}</span>}
            </div>
            {s.description && <div className="player-detail-news-body">{s.description}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function PlayerDetailPage() {
  const { leagueId, playerId } = useParams()
  const { league } = useOutletContext()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [imgFailed, setImgFailed] = useState(false)

  useEffect(() => {
    setLoading(true)
    setError('')
    api.leagues.player(leagueId, playerId)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [leagueId, playerId])

  if (loading) return <div className="loading-state"><span className="loading-spinner" /> Loading player…</div>
  if (error) return (
    <div>
      <Link to={`/leagues/${leagueId}/players`} className="back-link">← Players</Link>
      <div className="alert alert-error">{error}</div>
    </div>
  )
  if (!data) return null

  const { player, injuryStatus, injuryDescription, featuredStats, gameLog, spotlightStories } = data
  const hasLandingData = featuredStats || (gameLog && gameLog.length) || (spotlightStories && spotlightStories.length)

  return (
    <div className="player-detail-page">
      <Link to={`/leagues/${leagueId}/players`} className="back-link">← Players</Link>

      {/* Header */}
      <div className="player-detail-header card">
        {player.crest_url && <img src={player.crest_url} alt="" className="player-detail-crest" aria-hidden="true" />}
        {player.headshot_url && !imgFailed
          ? <img src={player.headshot_url} alt="" className="player-detail-headshot" onError={() => setImgFailed(true)} />
          : <div className="player-detail-headshot player-headshot-placeholder">{player.position}</div>}
        <div className="player-detail-info">
          <div className="player-detail-name">
            {player.name}
            <PlayerStatusBadge injuryStatus={injuryStatus} injuryDescription={injuryDescription} />
          </div>
          <div className="player-meta">
            {player.nhl_team && <span className="player-team-badge">{player.nhl_team}</span>}
            <span className={`player-pos-badge ${(player.position || '').toLowerCase()}`}>
              {player.position_detail || player.position}
            </span>
          </div>
        </div>
      </div>

      {/* Injury banner */}
      {injuryStatus && (
        <div className="player-detail-injury-banner alert alert-error">
          <strong>{injuryStatus}</strong>{injuryDescription ? `: ${injuryDescription}` : ''}
        </div>
      )}

      {hasLandingData ? (
        <>
          {/* Stats grid */}
          {featuredStats && (
            <div className="player-detail-section">
              <h3 className="player-detail-section-title">Current Season Stats</h3>
              <StatGrid position={player.position} featuredStats={featuredStats} />
            </div>
          )}

          {/* Game log */}
          <GameLogTable position={player.position} gameLog={gameLog} />

          {/* News */}
          <NewsStories spotlightStories={spotlightStories} />
        </>
      ) : (
        <div className="empty-state-inline" style={{ marginTop: 24 }}>
          No additional player data available yet — check back after the next cron refresh.
        </div>
      )}
    </div>
  )
}
