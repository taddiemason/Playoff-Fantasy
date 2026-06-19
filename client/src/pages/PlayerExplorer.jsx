import { useState, useEffect, useCallback } from 'react'
import { useParams, useOutletContext, Link } from 'react-router-dom'
import { api } from '../api.js'

const POS_LABEL = { F: 'Forward', D: 'Defenseman', G: 'Goalie' }

function debounce(fn, ms) {
  let timer
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms) }
}

function StatChips({ position, stats }) {
  if (!stats) return <span className="no-stats-msg">No playoff data</span>
  if (position === 'G') {
    return (
      <div className="player-stats-mini">
        <div className="stat-chip"><div className="stat-chip-value">{stats.wins ?? 0}</div><div className="stat-chip-label">W</div></div>
        <div className="stat-chip"><div className="stat-chip-value">{stats.shutouts ?? 0}</div><div className="stat-chip-label">SO</div></div>
        <div className="stat-chip"><div className="stat-chip-value">{stats.goalsAgainstAverage?.toFixed(2) ?? '–'}</div><div className="stat-chip-label">GAA</div></div>
        <div className="stat-chip"><div className="stat-chip-value">{stats.savePct ? stats.savePct.toFixed(3) : '–'}</div><div className="stat-chip-label">SV%</div></div>
      </div>
    )
  }
  return (
    <div className="player-stats-mini">
      <div className="stat-chip"><div className="stat-chip-value">{stats.goals ?? 0}</div><div className="stat-chip-label">G</div></div>
      <div className="stat-chip"><div className="stat-chip-value">{stats.assists ?? 0}</div><div className="stat-chip-label">A</div></div>
      <div className="stat-chip"><div className={`stat-chip-value ${(stats.plusMinus ?? 0) > 0 ? 'pm-positive' : (stats.plusMinus ?? 0) < 0 ? 'pm-negative' : ''}`}>{(stats.plusMinus ?? 0) > 0 ? '+' : ''}{stats.plusMinus ?? 0}</div><div className="stat-chip-label">+/-</div></div>
      <div className="stat-chip"><div className="stat-chip-value">{stats.penaltyMinutes ?? 0}</div><div className="stat-chip-label">PIM</div></div>
    </div>
  )
}

function PlayerDetail({ leagueId, detail }) {
  const { player, stats, points, partial, owners, ownershipPct, totalTeams, eliminated } = detail
  const [imgFail, setImgFail] = useState(false)
  return (
    <div className={`card explorer-detail${eliminated ? ' eliminated' : ''}`}>
      {player.crest_url && <img src={player.crest_url} alt="" className="explorer-crest" aria-hidden="true" />}
      <div className="explorer-detail-head">
        {player.headshot_url && !imgFail
          ? <img src={player.headshot_url} alt="" className="explorer-headshot" onError={() => setImgFail(true)} />
          : <div className="explorer-headshot player-headshot-placeholder">{player.position}</div>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="explorer-name">{player.name}</div>
          <div className="player-meta">
            {player.nhl_team && <span className="player-team-badge">{player.nhl_team}</span>}
            <span className={`player-pos-badge ${player.position.toLowerCase()}`}>{player.position_detail || POS_LABEL[player.position]}</span>
            <span className={`status-dot ${eliminated ? 'out' : 'alive'}`}>{eliminated ? 'Eliminated' : 'Alive'}</span>
          </div>
        </div>
        <div className="team-total-points">
          <div className="team-total-value">{points}{partial && <span className="partial-mark">*</span>}</div>
          <div className="team-total-label">Fantasy Pts</div>
        </div>
      </div>

      <div className="explorer-stats-row">
        <StatChips position={player.position} stats={stats} />
      </div>
      {partial && <div className="rules-note">* Goalie GAA/SV% ranking points apply only to rostered goalies — add this player to see their full total.</div>}

      <div className="explorer-ownership">
        <div className="explorer-own-head">
          Ownership <strong>{ownershipPct}%</strong> <span className="invite-sub">({owners.length} of {totalTeams} teams)</span>
        </div>
        {owners.length === 0 ? (
          <div className="empty-state-inline">Not rostered by anyone in this league — a sleeper pick.</div>
        ) : (
          <div className="owner-chips">
            {owners.map((o) => (
              <Link key={o.teamId} to={`/leagues/${leagueId}/teams/${o.teamId}`} className="owner-chip">
                {o.teamName}{o.owner ? ` · ${o.owner}` : ''}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default function PlayerExplorer() {
  const { leagueId } = useParams()
  const { league } = useOutletContext()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [detail, setDetail] = useState(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [rostered, setRostered] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.leagues.explorer(leagueId).then((d) => setRostered(d.players)).catch((e) => setError(e.message))
  }, [leagueId])

  const doSearch = useCallback(debounce(async (q) => {
    if (!q.trim() || q.trim().length < 2) { setResults([]); return }
    setSearching(true)
    try { setResults(await api.searchPlayers(q)) }
    catch { setResults([]) }
    finally { setSearching(false) }
  }, 350), [])

  async function loadPlayer(playerId) {
    setLoadingDetail(true)
    setError('')
    setResults([])
    setQuery('')
    try { setDetail(await api.leagues.player(leagueId, playerId)) }
    catch (err) { setError(err.message) }
    finally { setLoadingDetail(false) }
  }

  return (
    <div>
      <Link to={`/leagues/${leagueId}`} className="back-link">← {league.name}</Link>
      <div className="page-header"><div className="page-title">Player Explorer</div></div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="search-wrapper">
        <span className="search-icon">⌕</span>
        <input
          className="form-input search-input"
          placeholder="Search any NHL player…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); doSearch(e.target.value) }}
        />
      </div>
      {searching && <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '4px 0 12px' }}><span className="loading-spinner"></span> Searching…</div>}
      {results.length > 0 && (
        <div className="search-results" style={{ marginBottom: 16 }}>
          {results.map((p) => (
            <div key={p.playerId} className="search-result-item" onClick={() => loadPlayer(p.playerId)} style={{ cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {p.headshot ? <img src={p.headshot} alt="" className="player-headshot" /> : <div className="player-headshot-placeholder">{p.positionCode || '?'}</div>}
                <div className="result-info">
                  <div className="result-name">{p.name}</div>
                  <div className="result-meta">{p.teamAbbrev && <span>{p.teamAbbrev}</span>}{p.positionCode && <span>{p.positionCode}</span>}</div>
                </div>
              </div>
              <span className="btn btn-ghost btn-sm">View</span>
            </div>
          ))}
        </div>
      )}

      {loadingDetail ? (
        <div className="loading-state"><span className="loading-spinner"></span> Loading player…</div>
      ) : detail ? (
        <PlayerDetail leagueId={leagueId} detail={detail} />
      ) : null}

      <div className="dashboard-section-title" style={{ marginTop: 28 }}>Rostered in this league</div>
      {rostered === null ? (
        <div className="loading-state"><span className="loading-spinner"></span></div>
      ) : rostered.length === 0 ? (
        <div className="empty-state-inline">No players rostered yet.</div>
      ) : (
        <div className="standings-table">
          <div className="st-row explorer-row st-head">
            <div>Player</div><div className="st-num">Owners</div><div className="st-num">Own%</div><div className="st-num st-total">Pts</div>
          </div>
          {rostered.map((p) => (
            <div key={p.playerId} className={`st-row explorer-row st-data${p.eliminated ? ' eliminated' : ''}`} onClick={() => loadPlayer(p.playerId)}>
              <div className="explorer-cell">
                <span className={`player-pos-badge ${p.position.toLowerCase()}`}>{p.position}</span>
                <span className="explorer-cell-name">{p.name}</span>
                {p.nhl_team && <span className="player-team-badge">{p.nhl_team}</span>}
              </div>
              <div className="st-num">{p.ownerCount}</div>
              <div className="st-num">{p.ownershipPct}%</div>
              <div className="st-num st-total">{p.points}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
