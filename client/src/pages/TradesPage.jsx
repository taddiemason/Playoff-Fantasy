// client/src/pages/TradesPage.jsx
import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.jsx'
import { api } from '../api.js'
import TradeProposalModal from '../components/TradeProposalModal.jsx'

export default function TradesPage() {
  const { leagueId } = useParams()
  const { user } = useAuth()
  const [trades, setTrades] = useState([])
  const [teams, setTeams] = useState([])
  const [myTeam, setMyTeam] = useState(null)
  const [showModal, setShowModal] = useState(false)
  const [msg, setMsg] = useState('')

  async function load() {
    const [t, teamsData] = await Promise.all([
      api.leagues.trades.list(leagueId),
      api.leagues.getTeams(leagueId),
    ])
    setTrades(t.trades || [])
    setTeams(teamsData)
    setMyTeam(teamsData.find(t => t.user_id === user?.id) || null)
  }

  useEffect(() => { load() }, [leagueId])

  async function respond(tradeId, action) {
    try {
      await api.leagues.trades[action](leagueId, tradeId)
      setMsg(`Trade ${action}ed.`)
      load()
    } catch (e) { setMsg(e.message) }
  }

  const incoming = trades.filter(t => t.receiving_team_id === myTeam?.id && t.status === 'pending')
  const outgoing = trades.filter(t => t.proposing_team_id === myTeam?.id && t.status === 'pending')
  const history  = trades.filter(t => !['pending'].includes(t.status))

  return (
    <div className="page-container">
      <h2>Trades</h2>
      {msg && <div className="alert">{msg}</div>}
      <button onClick={() => setShowModal(true)} style={{ marginBottom: '1.5rem' }}>+ Propose Trade</button>

      <section style={{ marginBottom: '1.5rem' }}>
        <h3>Incoming Offers ({incoming.length})</h3>
        {incoming.length === 0
          ? <p className="st-dim">No pending offers.</p>
          : incoming.map(t => (
              <TradeCard key={t.id} trade={t}>
                <button onClick={() => respond(t.id, 'accept')}>Accept</button>
                <button onClick={() => respond(t.id, 'reject')}>Reject</button>
              </TradeCard>
            ))
        }
      </section>

      <section style={{ marginBottom: '1.5rem' }}>
        <h3>Outgoing Offers ({outgoing.length})</h3>
        {outgoing.length === 0
          ? <p className="st-dim">No outgoing offers.</p>
          : outgoing.map(t => <TradeCard key={t.id} trade={t} />)
        }
      </section>

      <section>
        <h3>History</h3>
        {history.length === 0
          ? <p className="st-dim">No trade history.</p>
          : history.map(t => <TradeCard key={t.id} trade={t} />)
        }
      </section>

      {showModal && (
        <TradeProposalModal
          leagueId={leagueId}
          myTeam={myTeam}
          teams={teams.filter(t => t.id !== myTeam?.id)}
          onClose={() => setShowModal(false)}
          onProposed={() => { setShowModal(false); load(); setMsg('Trade proposed!') }}
        />
      )}
    </div>
  )
}

function TradeCard({ trade, children }) {
  const offering   = (trade.items || []).filter(i => i.from_team_id === trade.proposing_team_id)
  const requesting = (trade.items || []).filter(i => i.from_team_id === trade.receiving_team_id)
  return (
    <div style={{ padding: '0.75rem 0', borderBottom: '1px solid var(--border)' }}>
      <div>
        <strong>{trade.proposing_team_name}</strong> offers: {offering.map(i => i.player_name).join(', ') || '—'}
      </div>
      <div>
        For <strong>{trade.receiving_team_name}</strong>: {requesting.map(i => i.player_name).join(', ') || '—'}
      </div>
      <div className="st-dim" style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>
        {trade.status} · {new Date(trade.created_at).toLocaleDateString()}
        {trade.veto_deadline && trade.status === 'accepted' && ` · Veto deadline: ${new Date(trade.veto_deadline).toLocaleString()}`}
      </div>
      {children && <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem' }}>{children}</div>}
    </div>
  )
}
