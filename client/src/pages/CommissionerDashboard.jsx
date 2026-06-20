import { useState, useEffect, useCallback } from 'react'
import { useParams, useOutletContext, Link } from 'react-router-dom'
import { api } from '../api.js'
import Avatar from '../components/Avatar.jsx'

function inviteLink(code) {
  return `${window.location.origin}/join/${code}`
}

export default function CommissionerDashboard() {
  const { leagueId } = useParams()
  const { league, refreshLeague } = useOutletContext()
  const isCommissioner = league.role === 'commissioner'

  // ── Settings form state (seeded from league config) ──
  const [name, setName] = useState(league.name)
  const [locked, setLocked] = useState(!!league.is_locked)
  const [cfg, setCfg] = useState(() => JSON.parse(JSON.stringify(league.config)))
  const [savingSettings, setSavingSettings] = useState(false)
  const [settingsMsg, setSettingsMsg] = useState(null)

  const [members, setMembers] = useState(null)
  const [invites, setInvites] = useState(null)
  const [leagueCode, setLeagueCode] = useState(league.invite_code)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')

  // Invite creation form
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteMaxUses, setInviteMaxUses] = useState('')
  const [inviteDays, setInviteDays] = useState('')
  const [creatingInvite, setCreatingInvite] = useState(false)

  // Schedule generation form
  const [schedStartDate, setSchedStartDate] = useState('')
  const [schedWeeks, setSchedWeeks] = useState(10)
  const [schedMsg, setSchedMsg] = useState(null)
  const [scheduling, setScheduling] = useState(false)

  // Trade veto and waiver priority reset
  const [pendingTrades, setPendingTrades] = useState([])
  const [vetoMsg, setVetoMsg] = useState('')
  const [priorityMsg, setPriorityMsg] = useState('')

  // Draft setup
  const [draftSession, setDraftSession] = useState(null)
  const [draftMsg, setDraftMsg] = useState('')
  const [pickTimer, setPickTimer] = useState(() => league.config?.pick_timer_seconds ?? 90)

  // Auction setup
  const [auctionSession, setAuctionSession] = useState(null)
  const [auctionMsg, setAuctionMsg] = useState('')
  const [auctionBudget, setAuctionBudget] = useState(() => league.config?.auction_budget ?? 1000)
  const [bidTimer, setBidTimer] = useState(() => league.config?.bid_timer_seconds ?? 30)

  const loadMembers = useCallback(() => {
    api.leagues.getMembers(leagueId).then(setMembers).catch((e) => setError(e.message))
  }, [leagueId])
  const loadInvites = useCallback(() => {
    api.leagues.getInvites(leagueId).then((d) => { setInvites(d.invites); setLeagueCode(d.leagueCode) }).catch((e) => setError(e.message))
  }, [leagueId])

  useEffect(() => { if (isCommissioner) { loadMembers(); loadInvites() } }, [isCommissioner, loadMembers, loadInvites])

  useEffect(() => {
    api.leagues.trades.list(leagueId).then(d => {
      setPendingTrades((d.trades || []).filter(t => t.status === 'accepted'))
    }).catch(() => {})
  }, [leagueId])

  useEffect(() => {
    api.leagues.draft.getSession(leagueId).then(d => setDraftSession(d.session)).catch(() => {})
  }, [leagueId])

  useEffect(() => {
    api.leagues.auction.getSession(leagueId).then(data => {
      if (data?.session) setAuctionSession(data.session);
    }).catch(() => {});
  }, [leagueId])

  if (!isCommissioner) {
    return (
      <div>
        <Link to={`/leagues/${leagueId}`} className="back-link">← {league.name}</Link>
        <div className="alert alert-error">This page is for commissioners only.</div>
      </div>
    )
  }

  function setSkater(k, v) { setCfg((c) => ({ ...c, scoring: { ...c.scoring, skater: { ...c.scoring.skater, [k]: v } } })) }
  function setGoalie(k, v) { setCfg((c) => ({ ...c, scoring: { ...c.scoring, goalie: { ...c.scoring.goalie, [k]: v } } })) }
  function setRoster(k, v) { setCfg((c) => ({ ...c, roster: { ...c.roster, [k]: v } })) }
  function setPayout(i, k, v) { setCfg((c) => ({ ...c, payout: c.payout.map((t, idx) => idx === i ? { ...t, [k]: v } : t) })) }
  function addPayout() { setCfg((c) => ({ ...c, payout: [...c.payout, { minEntries: 0, split: '' }] })) }
  function removePayout(i) { setCfg((c) => ({ ...c, payout: c.payout.filter((_, idx) => idx !== i) })) }

  async function saveSettings(e) {
    e.preventDefault()
    setSavingSettings(true)
    setSettingsMsg(null)
    try {
      const num = (v) => (v === '' || v == null ? 0 : parseFloat(v))
      const cleanCfg = {
        ...cfg,
        scoring: {
          skater: {
            goal: num(cfg.scoring.skater.goal), assist: num(cfg.scoring.skater.assist),
            specialTeamsPointBonus: num(cfg.scoring.skater.specialTeamsPointBonus), pim: num(cfg.scoring.skater.pim),
          },
          goalie: {
            win: num(cfg.scoring.goalie.win), shutout: num(cfg.scoring.goalie.shutout),
            gaaRank: !!cfg.scoring.goalie.gaaRank, svpRank: !!cfg.scoring.goalie.svpRank,
          },
        },
        roster: {
          maxF: num(cfg.roster.maxF), maxD: num(cfg.roster.maxD), maxG: num(cfg.roster.maxG),
          maxSameTeamF: num(cfg.roster.maxSameTeamF), maxSameTeamD: num(cfg.roster.maxSameTeamD),
        },
        payout: cfg.payout.map((t) => ({ minEntries: parseInt(t.minEntries) || 0, split: t.split })),
      }
      await api.leagues.update(leagueId, { name: name.trim(), is_locked: locked, config: cleanCfg })
      await refreshLeague()
      setSettingsMsg({ type: 'info', text: 'Settings saved' })
    } catch (err) {
      setSettingsMsg({ type: 'error', text: err.message })
    } finally {
      setSavingSettings(false)
    }
  }

  async function generateSchedule(e) {
    e.preventDefault()
    if (!schedStartDate || !schedWeeks) return
    setScheduling(true)
    setSchedMsg(null)
    try {
      const result = await api.leagues.schedule.generate(leagueId, schedStartDate, Number(schedWeeks))
      setSchedMsg({ type: 'success', text: `Schedule created: ${result.periods.length} weeks` })
    } catch (err) {
      setSchedMsg({ type: 'error', text: err.message })
    } finally {
      setScheduling(false)
    }
  }

  async function handleRemoveMember(m) {
    if (!confirm(`Remove ${m.username} from the league? Their teams in this league will be deleted.`)) return
    try { await api.leagues.removeMember(leagueId, m.user_id); loadMembers() }
    catch (err) { setError(err.message) }
  }

  async function handleCreateInvite(e) {
    e.preventDefault()
    setCreatingInvite(true)
    try {
      await api.leagues.createInvite(leagueId, {
        email: inviteEmail.trim() || undefined,
        maxUses: inviteMaxUses ? parseInt(inviteMaxUses) : undefined,
        expiresInDays: inviteDays ? parseInt(inviteDays) : undefined,
      })
      setInviteEmail(''); setInviteMaxUses(''); setInviteDays('')
      loadInvites()
    } catch (err) { setError(err.message) }
    finally { setCreatingInvite(false) }
  }

  async function handleRevoke(inv) {
    if (!confirm('Revoke this invite code?')) return
    try { await api.leagues.revokeInvite(leagueId, inv.id); loadInvites() }
    catch (err) { setError(err.message) }
  }

  function copy(code, label) {
    navigator.clipboard?.writeText(inviteLink(code))
    setCopied(label)
    setTimeout(() => setCopied(''), 2000)
  }

  async function vetoTrade(tradeId) {
    try {
      await api.leagues.trades.veto(leagueId, tradeId)
      setVetoMsg('Trade vetoed.')
      setPendingTrades(prev => prev.filter(t => t.id !== tradeId))
    } catch (e) { setVetoMsg(e.message) }
  }

  async function resetPriorities() {
    try {
      await api.leagues.waivers.resetPriorities(leagueId)
      setPriorityMsg('Waiver priorities reset to 0 for all teams.')
    } catch (e) { setPriorityMsg(e.message) }
  }

  async function createDraftSession() {
    try {
      await api.leagues.draft.create(leagueId)
      setDraftMsg('Draft session created. Go to the Draft page to set order and start.')
      const d = await api.leagues.draft.getSession(leagueId)
      setDraftSession(d.session)
    } catch (e) { setDraftMsg(e.message) }
  }

  async function savePickTimer() {
    try {
      await api.leagues.update(leagueId, { pick_timer_seconds: Number(pickTimer) })
      setDraftMsg('Pick timer saved.')
    } catch (e) { setDraftMsg(e.message) }
  }

  async function createAuctionSession() {
    try {
      await api.leagues.auction.create(leagueId);
      const data = await api.leagues.auction.getSession(leagueId);
      setAuctionSession(data?.session || null);
      setAuctionMsg('Auction session created.');
    } catch (e) { setAuctionMsg(e.message); }
  }

  async function saveAuctionConfig() {
    try {
      await api.leagues.update(leagueId, {
        config: { auction_budget: parseInt(auctionBudget), bid_timer_seconds: parseInt(bidTimer) }
      });
      setAuctionMsg('Auction settings saved.');
    } catch (e) { setAuctionMsg(e.message); }
  }

  return (
    <div>
      <Link to={`/leagues/${leagueId}`} className="back-link">← {league.name}</Link>
      <div className="page-header"><div className="page-title">Manage League</div></div>

      {error && <div className="alert alert-error">{error}</div>}

      {/* ── Settings ── */}
      <form className="card settings-card" onSubmit={saveSettings} style={{ marginBottom: 16 }}>
        <div className="settings-card-title">League Settings</div>
        {settingsMsg && <div className={`alert alert-${settingsMsg.type}`}>{settingsMsg.text}</div>}

        <div className="form-group">
          <label className="form-label">League Name</label>
          <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <label className="lock-toggle">
          <input type="checkbox" checked={locked} onChange={(e) => setLocked(e.target.checked)} />
          <span>Lock league (rosters become final — members can no longer edit)</span>
        </label>

        <div className="form-group">
          <label className="form-label">Description</label>
          <textarea className="form-input" rows={3} value={cfg.description || ''} onChange={(e) => setCfg((c) => ({ ...c, description: e.target.value }))} />
        </div>
        <div className="form-group">
          <label className="form-label">Commissioner Notes (shown on league home)</label>
          <textarea className="form-input" rows={2} value={cfg.commissionerNotes || ''} onChange={(e) => setCfg((c) => ({ ...c, commissionerNotes: e.target.value }))} />
        </div>

        <div className="admin-cfg-grid">
          <div>
            <div className="rules-col-title">Skater Scoring</div>
            <NumRow label="Goal" value={cfg.scoring.skater.goal} onChange={(v) => setSkater('goal', v)} />
            <NumRow label="Assist" value={cfg.scoring.skater.assist} onChange={(v) => setSkater('assist', v)} />
            <NumRow label="Special Teams Pt" value={cfg.scoring.skater.specialTeamsPointBonus} onChange={(v) => setSkater('specialTeamsPointBonus', v)} />
            <NumRow label="Penalty Minute" value={cfg.scoring.skater.pim} onChange={(v) => setSkater('pim', v)} />
          </div>
          <div>
            <div className="rules-col-title">Goalie Scoring</div>
            <NumRow label="Win" value={cfg.scoring.goalie.win} onChange={(v) => setGoalie('win', v)} />
            <NumRow label="Shutout" value={cfg.scoring.goalie.shutout} onChange={(v) => setGoalie('shutout', v)} />
            <label className="lock-toggle sm"><input type="checkbox" checked={!!cfg.scoring.goalie.gaaRank} onChange={(e) => setGoalie('gaaRank', e.target.checked)} /><span>GAA ranking</span></label>
            <label className="lock-toggle sm"><input type="checkbox" checked={!!cfg.scoring.goalie.svpRank} onChange={(e) => setGoalie('svpRank', e.target.checked)} /><span>SV% ranking</span></label>
          </div>
          <div>
            <div className="rules-col-title">Roster Sizes</div>
            <NumRow label="Forwards" value={cfg.roster.maxF} onChange={(v) => setRoster('maxF', v)} />
            <NumRow label="Defensemen" value={cfg.roster.maxD} onChange={(v) => setRoster('maxD', v)} />
            <NumRow label="Goalies" value={cfg.roster.maxG} onChange={(v) => setRoster('maxG', v)} />
            <NumRow label="Max F / NHL team" value={cfg.roster.maxSameTeamF} onChange={(v) => setRoster('maxSameTeamF', v)} />
            <NumRow label="Max D / NHL team" value={cfg.roster.maxSameTeamD} onChange={(v) => setRoster('maxSameTeamD', v)} />
          </div>
        </div>

        <div className="rules-col-title" style={{ marginTop: 16 }}>Payout Structure</div>
        {cfg.payout.map((tier, i) => (
          <div className="payout-edit-row" key={i}>
            <input className="form-input" type="number" style={{ width: 90 }} value={tier.minEntries} onChange={(e) => setPayout(i, 'minEntries', e.target.value)} placeholder="min" />
            <input className="form-input" value={tier.split} onChange={(e) => setPayout(i, 'split', e.target.value)} placeholder="e.g. 75% / 25%" />
            <button type="button" className="btn btn-danger btn-sm" onClick={() => removePayout(i)}>×</button>
          </div>
        ))}
        <button type="button" className="btn btn-ghost btn-sm" onClick={addPayout} style={{ marginTop: 6 }}>+ Add tier</button>

        <div style={{ marginTop: 18 }}>
          <button className="btn btn-primary" type="submit" disabled={savingSettings}>
            {savingSettings ? 'Saving…' : 'Save Settings'}
          </button>
        </div>
      </form>

      {/* ── Invites ── */}
      <div className="card settings-card" style={{ marginBottom: 16 }}>
        <div className="settings-card-title">Invites</div>
        <div className="invite-row">
          <div>
            <div className="invite-code">{leagueCode}</div>
            <div className="invite-sub">Permanent league code</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => copy(leagueCode, 'league')}>{copied === 'league' ? 'Copied!' : 'Copy link'}</button>
        </div>

        <form className="invite-create" onSubmit={handleCreateInvite}>
          <input className="form-input" placeholder="Email (optional)" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
          <input className="form-input" type="number" placeholder="Max uses" value={inviteMaxUses} onChange={(e) => setInviteMaxUses(e.target.value)} style={{ width: 110 }} />
          <input className="form-input" type="number" placeholder="Expires (days)" value={inviteDays} onChange={(e) => setInviteDays(e.target.value)} style={{ width: 130 }} />
          <button className="btn btn-primary btn-sm" type="submit" disabled={creatingInvite}>{creatingInvite ? '…' : 'Generate'}</button>
        </form>

        {invites === null ? (
          <div className="loading-state"><span className="loading-spinner"></span></div>
        ) : invites.length === 0 ? (
          <div className="empty-state-inline">No generated invites yet.</div>
        ) : (
          invites.map((inv) => (
            <div className="invite-row" key={inv.id}>
              <div>
                <div className="invite-code">{inv.code}</div>
                <div className="invite-sub">
                  <span className={`invite-status ${inv.status === 'active' ? 'ok' : 'off'}`}>{inv.status}</span>
                  {inv.email && ` · ${inv.email}`}
                  {` · uses ${inv.use_count}${inv.max_uses ? `/${inv.max_uses}` : ''}`}
                  {inv.expires_at && ` · expires ${new Date(inv.expires_at).toLocaleDateString()}`}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => copy(inv.code, inv.code)}>{copied === inv.code ? 'Copied!' : 'Copy'}</button>
                {inv.status === 'active' && <button className="btn btn-danger btn-sm" onClick={() => handleRevoke(inv)}>Revoke</button>}
              </div>
            </div>
          ))
        )}
      </div>

      {/* ── Schedule Generation ── */}
      <section className="card" style={{ marginTop: '2rem' }}>
        <h2 className="section-title">Season Schedule</h2>
        <form onSubmit={generateSchedule} className="form-stack">
          <div className="form-row">
            <label className="form-label">Start Date</label>
            <input
              type="date"
              className="input"
              value={schedStartDate}
              onChange={e => setSchedStartDate(e.target.value)}
              required
            />
          </div>
          <div className="form-row">
            <label className="form-label">Number of Weeks</label>
            <input
              type="number"
              className="input"
              min={1}
              max={52}
              value={schedWeeks}
              onChange={e => setSchedWeeks(e.target.value)}
              required
            />
          </div>
          {schedMsg && (
            <div className={`alert alert-${schedMsg.type === 'success' ? 'success' : 'error'}`}>
              {schedMsg.text}
            </div>
          )}
          <button type="submit" className="btn btn-primary" disabled={scheduling}>
            {scheduling ? 'Generating…' : 'Generate Schedule'}
          </button>
          <p className="hint">Regenerating overwrites the existing schedule.</p>
        </form>
      </section>

      {/* ── Trade Veto Queue ── */}
      <section style={{ marginTop: '2rem' }}>
        <h3>Trade Veto Queue</h3>
        {vetoMsg && <div className="alert">{vetoMsg}</div>}
        {pendingTrades.length === 0
          ? <p className="st-dim">No accepted trades pending veto review.</p>
          : pendingTrades.map(t => {
              const offering   = (t.items || []).filter(i => i.from_team_id === t.proposing_team_id)
              const requesting = (t.items || []).filter(i => i.from_team_id === t.receiving_team_id)
              return (
                <div key={t.id} style={{ padding: '0.75rem 0', borderBottom: '1px solid var(--border)' }}>
                  <div><strong>{t.proposing_team_name}</strong>: {offering.map(i => i.player_name).join(', ')}</div>
                  <div>For <strong>{t.receiving_team_name}</strong>: {requesting.map(i => i.player_name).join(', ')}</div>
                  <div className="st-dim" style={{ fontSize: '0.8rem' }}>
                    Veto deadline: {new Date(t.veto_deadline).toLocaleString()}
                  </div>
                  <button onClick={() => vetoTrade(t.id)} style={{ marginTop: '0.5rem' }}>Veto Trade</button>
                </div>
              )
            })
        }
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h3>Waiver Priorities</h3>
        {priorityMsg && <div className="alert">{priorityMsg}</div>}
        <p className="st-dim">Resets all team waiver priorities to 0 (equal standing).</p>
        <button onClick={resetPriorities}>Reset Waiver Priorities</button>
      </section>

      {/* ── Draft Setup ── */}
      <div style={{ marginTop: '2rem', borderTop: '1px solid #333', paddingTop: '1rem' }}>
        <h3>Draft Setup</h3>
        {draftMsg && <p className="alert">{draftMsg}</p>}

        <div style={{ marginBottom: '1rem' }}>
          <label>Pick Timer (seconds)
            <input
              type="number"
              min={15}
              max={300}
              value={pickTimer}
              onChange={e => setPickTimer(e.target.value)}
              style={{ marginLeft: '0.5rem', width: 70 }}
            />
          </label>
          <button onClick={savePickTimer} style={{ marginLeft: '0.5rem' }}>Save Timer</button>
        </div>

        {!draftSession ? (
          <button onClick={createDraftSession}>Create Draft Session</button>
        ) : (
          <p className="st-dim">
            Draft session exists (status: <strong>{draftSession.status}</strong>).{' '}
            <a href={`/leagues/${leagueId}/draft`}>Go to Draft Room →</a>
          </p>
        )}
      </div>

      {/* ── Auction Setup ── */}
      <div className="card" style={{ marginTop: '1.5rem' }}>
        <h3 style={{ marginTop: 0 }}>Auction Setup</h3>

        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: '0.8rem', color: '#888' }}>Budget per team ($)</span>
            <input
              type="number" min={100} max={10000} step={100}
              value={auctionBudget}
              onChange={e => setAuctionBudget(e.target.value)}
              style={{ width: 100 }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: '0.8rem', color: '#888' }}>Bid timer (seconds)</span>
            <input
              type="number" min={10} max={120}
              value={bidTimer}
              onChange={e => setBidTimer(e.target.value)}
              style={{ width: 80 }}
            />
          </label>
          <button onClick={saveAuctionConfig}>Save</button>
        </div>

        {!auctionSession ? (
          <button onClick={createAuctionSession}>Create Auction Session</button>
        ) : (
          <p style={{ color: '#888', fontSize: '0.85rem' }}>
            Session status: <strong>{auctionSession.status}</strong> —{' '}
            <a href={`/leagues/${leagueId}/auction`} style={{ color: '#3498db' }}>Go to Auction Room</a>
          </p>
        )}

        {auctionMsg && <p style={{ color: '#e67e22', marginTop: '0.5rem' }}>{auctionMsg}</p>}
      </div>

      {/* ── Members ── */}
      <div className="card settings-card">
        <div className="settings-card-title">Members</div>
        {members === null ? (
          <div className="loading-state"><span className="loading-spinner"></span></div>
        ) : (
          members.map((m) => (
            <div className="member-row" key={m.user_id}>
              <Avatar user={m} size={32} />
              <div className="member-info">
                <div className="member-name">
                  {m.username}
                  {m.isOwner && <span className="role-badge commish" style={{ marginLeft: 8 }}>Owner</span>}
                </div>
                <div className="member-sub">{m.email} · {m.teamCount} {m.teamCount === 1 ? 'team' : 'teams'}</div>
              </div>
              {!m.isOwner && (
                <button className="btn btn-danger btn-sm" onClick={() => handleRemoveMember(m)}>Remove</button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function NumRow({ label, value, onChange }) {
  return (
    <div className="num-row">
      <span>{label}</span>
      <input className="form-input num-input" type="number" step="0.5" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}
