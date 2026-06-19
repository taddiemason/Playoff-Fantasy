import { api } from '../api.js'
import PlayerSearch from './PlayerSearch.jsx'

export default function AddPlayerModal({ leagueId, teamId, roster, caps, onClose, onAdded }) {
  async function handleAdd(payload) {
    const added = await api.leagues.addPlayer(leagueId, teamId, payload)
    onAdded(added)
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <span className="modal-title">Add Player</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <PlayerSearch roster={roster} caps={caps} onAdd={handleAdd} />
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
