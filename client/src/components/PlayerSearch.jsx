import { useState, useCallback } from 'react'
import { api } from '../api.js'

const POS_MAP = { C: 'F', LW: 'F', RW: 'F', D: 'D', G: 'G' }
const POS_LABEL = { F: 'Forward', D: 'Defenseman', G: 'Goalie' }

function PlayerSearchHeadshot({ src, pos }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) return <div className="player-headshot-placeholder">{pos}</div>
  return <img src={src} alt="" className="player-headshot" onError={() => setFailed(true)} />
}

function debounce(fn, ms) {
  let timer
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms) }
}

// Shared NHL player search + live roster-cap validation. `onAdd(payload)` should
// persist the player and resolve once the roster is updated (throw to show error).
export default function PlayerSearch({ roster, caps, onAdd }) {
  const limits = caps || { maxF: 10, maxD: 5, maxG: 3, maxSameTeamF: 3, maxSameTeamD: 2 }
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const [addingId, setAddingId] = useState(null)

  const existingPlayerIds = new Set(roster.map((p) => p.player_id))
  const forwards = roster.filter((p) => p.position === 'F').length
  const defensemen = roster.filter((p) => p.position === 'D').length
  const goalies = roster.filter((p) => p.position === 'G').length

  const doSearch = useCallback(debounce(async (q) => {
    if (!q.trim() || q.trim().length < 2) { setResults([]); return }
    setSearching(true)
    setError('')
    try {
      const data = await api.searchPlayers(q)
      setResults(Array.isArray(data) ? data : [])
    } catch (err) {
      setError('Search failed: ' + err.message)
    } finally {
      setSearching(false)
    }
  }, 350), [])

  function handleQueryChange(e) {
    setQuery(e.target.value)
    doSearch(e.target.value)
  }

  async function handleAdd(player) {
    const position = POS_MAP[player.positionCode] || 'F'
    setAddingId(player.playerId)
    setError('')
    try {
      await onAdd({
        player_id: player.playerId,
        player_name: player.name,
        nhl_team: player.teamAbbrev || '',
        position,
        position_detail: player.positionCode || '',
        headshot_url: player.headshot || '',
      })
    } catch (err) {
      setError(err.message)
    } finally {
      setAddingId(null)
    }
  }

  const getTeamConflict = (player) => {
    const pos = POS_MAP[player.positionCode]
    if (pos === 'F') {
      const count = roster.filter((p) => p.position === 'F' && p.nhl_team === player.teamAbbrev).length
      return count >= limits.maxSameTeamF ? `${limits.maxSameTeamF}/${limits.maxSameTeamF} from ${player.teamAbbrev}` : null
    }
    if (pos === 'D') {
      const count = roster.filter((p) => p.position === 'D' && p.nhl_team === player.teamAbbrev).length
      return count >= limits.maxSameTeamD ? `${limits.maxSameTeamD}/${limits.maxSameTeamD} from ${player.teamAbbrev}` : null
    }
    return null
  }

  const getRosterConflict = (posCode) => {
    const pos = POS_MAP[posCode]
    if (pos === 'F' && forwards >= limits.maxF) return `F roster full (${limits.maxF}/${limits.maxF})`
    if (pos === 'D' && defensemen >= limits.maxD) return `D roster full (${limits.maxD}/${limits.maxD})`
    if (pos === 'G' && goalies >= limits.maxG) return `G roster full (${limits.maxG}/${limits.maxG})`
    return null
  }

  return (
    <div>
      <div className="roster-limits">
        <div className="limit-item">
          <span className="limit-label">Forwards</span>
          <span className={`limit-value ${forwards >= limits.maxF ? 'full' : 'ok'}`}>{forwards}/{limits.maxF}</span>
        </div>
        <div className="limit-item">
          <span className="limit-label">Defensemen</span>
          <span className={`limit-value ${defensemen >= limits.maxD ? 'full' : 'ok'}`}>{defensemen}/{limits.maxD}</span>
        </div>
        <div className="limit-item">
          <span className="limit-label">Goalies</span>
          <span className={`limit-value ${goalies >= limits.maxG ? 'full' : 'ok'}`}>{goalies}/{limits.maxG}</span>
        </div>
      </div>

      <div className="alert alert-info" style={{ fontSize: '12px', marginBottom: 14 }}>
        Forwards: max {limits.maxSameTeamF} per NHL team &nbsp;|&nbsp; Defensemen: max {limits.maxSameTeamD} per NHL team &nbsp;|&nbsp; Goalies: no team limit
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="search-wrapper">
        <span className="search-icon">⌕</span>
        <input
          className="form-input search-input"
          placeholder="Search player name (e.g. McDavid)..."
          value={query}
          onChange={handleQueryChange}
          autoFocus
        />
      </div>

      <div className="search-results">
        {searching && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', padding: '8px 0' }}>
            <span className="loading-spinner"></span> Searching...
          </div>
        )}

        {!searching && query.length >= 2 && results.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '8px 0' }}>
            No active players found for "{query}"
          </div>
        )}

        {results.map((player) => {
          const pos = POS_MAP[player.positionCode] || 'F'
          const alreadyOn = existingPlayerIds.has(player.playerId)
          const conflict = getRosterConflict(player.positionCode) || getTeamConflict(player)
          const disabled = alreadyOn || !!conflict || addingId === player.playerId

          return (
            <div key={player.playerId} className="search-result-item">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                <PlayerSearchHeadshot src={player.headshot} pos={pos} />
                <div className="result-info">
                  <div className="result-name">{player.name}</div>
                  <div className="result-meta">
                    <span className={`player-pos-badge ${pos.toLowerCase()}`}>{POS_LABEL[pos]}</span>
                    {player.teamAbbrev && <span>{player.teamAbbrev}</span>}
                    {player.sweaterNumber && <span>#{player.sweaterNumber}</span>}
                  </div>
                </div>
              </div>

              {alreadyOn ? (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>On roster</span>
              ) : conflict ? (
                <span style={{ fontSize: 11, color: 'var(--red)', maxWidth: 100, textAlign: 'right' }}>{conflict}</span>
              ) : (
                <button className="btn btn-primary btn-sm" onClick={() => handleAdd(player)} disabled={disabled}>
                  {addingId === player.playerId ? <span className="loading-spinner"></span> : '+ Add'}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
