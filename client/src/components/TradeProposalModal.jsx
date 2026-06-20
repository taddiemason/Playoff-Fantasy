// client/src/components/TradeProposalModal.jsx
import { useState, useEffect } from 'react'
import { api } from '../api.js'

export default function TradeProposalModal({ leagueId, myTeam, teams, onClose, onProposed }) {
  const [step, setStep] = useState(1)
  const [targetTeam, setTargetTeam] = useState(null)
  const [myPlayers, setMyPlayers] = useState([])
  const [theirPlayers, setTheirPlayers] = useState([])
  const [offering, setOffering] = useState([])
  const [requesting, setRequesting] = useState([])
  const [msg, setMsg] = useState('')

  useEffect(() => {
    api.leagues.getStandings(leagueId).then(d => {
      const entry = (d?.standings || []).find(s => s.id === myTeam?.id)
      setMyPlayers(entry?.players || [])
    })
  }, [myTeam])

  async function pickTarget(team) {
    setTargetTeam(team)
    const d = await api.leagues.getStandings(leagueId)
    const entry = (d?.standings || []).find(s => s.id === team.id)
    setTheirPlayers(entry?.players || [])
    setStep(2)
  }

  function toggle(list, setList, pid) {
    setList(prev => prev.includes(pid) ? prev.filter(id => id !== pid) : [...prev, pid])
  }

  async function submit() {
    try {
      await api.leagues.trades.propose(leagueId, targetTeam.id, offering, requesting)
      onProposed()
    } catch (e) { setMsg(e.message) }
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>Propose Trade</h3>
        {msg && <div className="alert alert-error">{msg}</div>}

        {step === 1 && (
          <>
            <p>Trade with which team?</p>
            {teams.map(t => (
              <button key={t.id} onClick={() => pickTarget(t)}
                style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: '0.5rem' }}>
                {t.name}
              </button>
            ))}
            <button onClick={onClose} style={{ marginTop: '1rem' }}>Cancel</button>
          </>
        )}

        {step === 2 && (
          <>
            <p><strong>You offer</strong> (select from your roster):</p>
            {myPlayers.map(p => (
              <label key={p.player_id} style={{ display: 'block', marginBottom: '0.25rem' }}>
                <input type="checkbox" checked={offering.includes(p.player_id)}
                  onChange={() => toggle(offering, setOffering, p.player_id)} />
                {' '}{p.player_name}
              </label>
            ))}
            <p style={{ marginTop: '1rem' }}><strong>You request</strong> (from {targetTeam.name}):</p>
            {theirPlayers.map(p => (
              <label key={p.player_id} style={{ display: 'block', marginBottom: '0.25rem' }}>
                <input type="checkbox" checked={requesting.includes(p.player_id)}
                  onChange={() => toggle(requesting, setRequesting, p.player_id)} />
                {' '}{p.player_name}
              </label>
            ))}
            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
              <button onClick={() => setStep(3)} disabled={offering.length === 0 || requesting.length === 0}>Review</button>
              <button onClick={() => setStep(1)}>Back</button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <p><strong>You offer:</strong> {myPlayers.filter(p => offering.includes(p.player_id)).map(p => p.player_name).join(', ')}</p>
            <p><strong>You request:</strong> {theirPlayers.filter(p => requesting.includes(p.player_id)).map(p => p.player_name).join(', ')}</p>
            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
              <button onClick={submit}>Send Proposal</button>
              <button onClick={() => setStep(2)}>Back</button>
              <button onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
