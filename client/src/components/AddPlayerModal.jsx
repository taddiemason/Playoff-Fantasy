import { useState, useCallback, useRef } from 'react'
import { api } from '../api.js'

const POS_MAP = { C: 'F', LW: 'F', RW: 'F', D: 'D', G: 'G' }
const POS_LABEL = { F: 'Forward', D: 'Defenseman', G: 'Goalie' }

function debounce(fn, ms) {
  let timer
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms) }
}

export default function AddPlayerModal({ teamId, existingPlayerIds, roster, onClose, onAdded, onUnauthorized }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const [addingId, setAddingId] = useState(null)

  const forwards = roster.filter(p => p.position === 'F').length
  const defensemen = roster.filter(p => p.position === 'D').length
  const goalies = roster.filter(p => p.position === 'G').length

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
    const q = e.target.value
    setQuery(q)
    doSearch(q)
  }

  async function handleAdd(player) {
    const position = POS_MAP[player.positionCode] || 'F'
    setAddingId(player.playerId)
    setError('')
    try {
      const added = await api.addPlayer(teamId, {
        player_id: player.playerId,
        player_name: player.name,
        nhl_team: player.teamAbbrev || '',
        position,
        position_detail: player.positionCode || '',
        headshot_url: player.headshot || ''
      })
      onAdded(added)
    } catch (err) {
      if (err.unauthorized) { onUnauthorized?.(); return }
      setError(err.message)
    } finally {
      setAddingId(null)
    }
  }

  const isOnTeam = (id) => existingPlayerIds.has(id)

  const getTeamConflict = (player) => {
    const pos = POS_MAP[player.positionCode]
    if (pos === 'F') {
      const count = roster.filter(p => p.position === 'F' && p.nhl_team === player.teamAbbrev).length
      return count >= 3 ? `3/${3} from ${player.teamAbbrev}` : null
    }
    if (pos === 'D') {
      const count = roster.filter(p => p.position === 'D' && p.nhl_team === player.teamAbbrev).length
      return count >= 2 ? `2/${2} from ${player.teamAbbrev}` : null
    }
    return null
  }

  const getRosterConflict = (posCode) => {
    const pos = POS_MAP[posCode]
    if (pos === 'F' && forwards >= 10) return 'F roster full (10/10)'
    if (pos === 'D' && defensemen >= 5) return 'D roster full (5/5)'
    if (pos === 'G' && goalies >= 3) return 'G roster full (3/3)'
    return null
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <span className="modal-title">Add Player</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {/* Roster status */}
          <div className="roster-limits">
            <div className="limit-item">
              <span className="limit-label">Forwards</span>
              <span className={`limit-value ${forwards >= 10 ? 'full' : 'ok'}`}>{forwards}/10</span>
            </div>
            <div className="limit-item">
              <span className="limit-label">Defensemen</span>
              <span className={`limit-value ${defensemen >= 5 ? 'full' : 'ok'}`}>{defensemen}/5</span>
            </div>
            <div className="limit-item">
              <span className="limit-label">Goalies</span>
              <span className={`limit-value ${goalies >= 3 ? 'full' : 'ok'}`}>{goalies}/3</span>
            </div>
          </div>

          <div className="alert alert-info" style={{ fontSize: '12px', marginBottom: 14 }}>
            Forwards: max 3 per NHL team &nbsp;|&nbsp; Defensemen: max 2 per NHL team &nbsp;|&nbsp; Goalies: no team limit
          </div>

          {error && <div className="alert alert-error">{error}</div>}

          <div className="search-wrapper">
            <span className="search-icon"></span>
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

            {results.map(player => {
              const pos = POS_MAP[player.positionCode] || 'F'
              const alreadyOn = isOnTeam(player.playerId)
              const rosterConflict = getRosterConflict(player.positionCode)
              const teamConflict = getTeamConflict(player)
              const conflict = rosterConflict || teamConflict
              const disabled = alreadyOn || !!conflict || addingId === player.playerId

              return (
                <div key={player.playerId} className="search-result-item">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                    {player.headshot
                      ? <img src={player.headshot} alt="" className="player-headshot" />
                      : <div className="player-headshot-placeholder">
                          {pos}
                        </div>
                    }
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
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => handleAdd(player)}
                      disabled={disabled}
                    >
                      {addingId === player.playerId
                        ? <span className="loading-spinner"></span>
                        : '+ Add'
                      }
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
