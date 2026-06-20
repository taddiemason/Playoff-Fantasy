import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useOutletContext } from 'react-router-dom';
import { api } from '../api';
import { useDraftSocket } from '../hooks/useDraftSocket';

function PreDraftLobby({ leagueId, initialSession, isCommissioner, onStart }) {
  const [session, setSession] = useState(initialSession);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);

  const draftOrder = session?.draft_order || [];
  const allSlotsFilled = draftOrder.length > 0 && draftOrder.every(t => t.teamId);

  async function createSession() {
    setLoading(true);
    try {
      await api.leagues.draft.create(leagueId);
      const { session: s } = await api.leagues.draft.getSession(leagueId);
      setSession(s);
      setMsg('Draft session created.');
    } catch (e) { setMsg(e.message); }
    setLoading(false);
  }

  async function randomize() {
    setLoading(true);
    try {
      await api.leagues.draft.randomize(leagueId);
      const { session: s } = await api.leagues.draft.getSession(leagueId);
      setSession(s);
      setMsg('Order randomized.');
    } catch (e) { setMsg(e.message); }
    setLoading(false);
  }

  async function startDraft() {
    setLoading(true);
    try {
      await api.leagues.draft.start(leagueId);
      onStart();
    } catch (e) { setMsg(e.message); }
    setLoading(false);
  }

  if (!session) {
    return (
      <div className="draft-lobby">
        <h2>Draft Room</h2>
        <p className="st-dim">No draft session exists yet.</p>
        {isCommissioner && (
          <button onClick={createSession} disabled={loading}>Create Draft Session</button>
        )}
        {msg && <p className="alert">{msg}</p>}
      </div>
    );
  }

  return (
    <div className="draft-lobby">
      <h2>Draft Room — Waiting to Start</h2>
      {msg && <p className="alert">{msg}</p>}

      <div className="draft-order-list" style={{ marginBottom: '1rem' }}>
        <h3>Draft Order</h3>
        {draftOrder.length === 0 ? (
          <p className="st-dim">No order set yet.</p>
        ) : (
          <ol>
            {draftOrder.map((t, i) => (
              <li key={t.teamId}>{i + 1}. {t.teamName}</li>
            ))}
          </ol>
        )}
      </div>

      {isCommissioner ? (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button onClick={randomize} disabled={loading}>Randomize Order</button>
          <button
            onClick={startDraft}
            disabled={loading || !allSlotsFilled}
            title={allSlotsFilled ? '' : 'Set draft order first'}
          >
            Start Draft
          </button>
        </div>
      ) : (
        <p className="st-dim">Waiting for the commissioner to start the draft…</p>
      )}
    </div>
  );
}

function DraftTimerBar({ pickDeadline, status, teamName }) {
  const [secs, setSecs] = useState(null);

  useEffect(() => {
    if (!pickDeadline || status !== 'active') { setSecs(null); return; }
    const tick = () => {
      const remaining = Math.max(0, Math.floor((new Date(pickDeadline) - Date.now()) / 1000));
      setSecs(remaining);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [pickDeadline, status]);

  if (status === 'completed') return null;
  if (status === 'paused') return (
    <div className="draft-timer" style={{ background: '#555', color: '#fff', padding: '0.5rem 1rem', borderRadius: 4 }}>
      ⏸ PAUSED
    </div>
  );

  const color = secs === null ? '#888' : secs <= 10 ? '#c0392b' : secs <= 20 ? '#e67e22' : '#27ae60';
  return (
    <div className="draft-timer" style={{ background: color, color: '#fff', padding: '0.5rem 1rem', borderRadius: 4 }}>
      {teamName ? `${teamName} is on the clock` : 'Waiting…'}
      {secs !== null && ` — ${secs}s`}
    </div>
  );
}

function DraftBoardGrid({ draftOrder, picks, currentPick, totalPicks, currentTeamId }) {
  const numTeams = draftOrder.length;
  if (numTeams === 0) return null;
  const numRounds = totalPicks > 0 ? Math.ceil(totalPicks / numTeams) : 0;

  // Build pick lookup: key = `${round}-${teamId}` -> pick object
  const pickMap = {};
  for (const p of picks) pickMap[`${p.round}-${p.teamId}`] = p;

  // For a snake draft: which teamId is at (round, slotInRound)?
  function teamAtSlot(round, slotInRound) {
    const idx = (round % 2 === 1) ? slotInRound : (numTeams - 1 - slotInRound);
    return draftOrder[idx]?.teamId;
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: '0.8rem', minWidth: '100%' }}>
        <thead>
          <tr>
            <th style={{ padding: '4px 8px', borderBottom: '1px solid #444' }}>Rd</th>
            {draftOrder.map(t => (
              <th key={t.teamId} style={{ padding: '4px 8px', borderBottom: '1px solid #444', whiteSpace: 'nowrap' }}>
                {t.teamName}
                {t.teamId === currentTeamId && <span style={{ color: '#f1c40f', marginLeft: 4 }}>▶</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: numRounds }, (_, ri) => {
            const round = ri + 1;
            return (
              <tr key={round}>
                <td style={{ padding: '4px 8px', color: '#888', fontWeight: 'bold' }}>{round}</td>
                {draftOrder.map((t, si) => {
                  const tid = teamAtSlot(round, si);
                  const pick = pickMap[`${round}-${tid}`];
                  const isCurrentSlot = !pick && teamAtSlot(round, si) === currentTeamId;
                  return (
                    <td key={t.teamId} style={{
                      padding: '4px 6px', border: '1px solid #333', maxWidth: 100,
                      background: isCurrentSlot ? '#2c3e50' : 'transparent',
                      outline: isCurrentSlot ? '2px solid #f1c40f' : 'none',
                    }}>
                      {pick ? (
                        <span title={pick.playerName}>
                          {pick.position && <span style={{ color: '#888', fontSize: '0.7rem', marginRight: 2 }}>{pick.position}</span>}
                          {pick.playerName}
                          {pick.isAutoPick && <span style={{ color: '#e67e22', fontSize: '0.7rem' }}> ✦</span>}
                        </span>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DraftAvailablePlayers({ available, myQueue, currentTeamId, myTeamId, status, send }) {
  const [tab, setTab] = useState('ALL');
  const [search, setSearch] = useState('');
  const queuedIds = new Set((myQueue || []).map(p => p.playerId));
  const isMyTurn = myTeamId && myTeamId === currentTeamId && status === 'active';

  const filtered = (available || []).filter(p => {
    if (tab !== 'ALL' && p.position !== tab) return false;
    if (search && !p.playerName.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="draft-available">
      <h3 style={{ marginTop: 0 }}>Available Players</h3>
      <input
        placeholder="Search…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ width: '100%', marginBottom: '0.5rem', boxSizing: 'border-box' }}
      />
      <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '0.5rem' }}>
        {['ALL', 'F', 'D', 'G'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{ fontWeight: tab === t ? 'bold' : 'normal' }}>
            {t}
          </button>
        ))}
      </div>
      <div style={{ maxHeight: 400, overflowY: 'auto' }}>
        {filtered.slice(0, 100).map(p => (
          <div key={p.playerId} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '4px 0', borderBottom: '1px solid #333' }}>
            {p.headshotUrl && <img src={p.headshotUrl} alt="" style={{ width: 28, height: 28, borderRadius: '50%' }} />}
            <span style={{ flex: 1 }}>
              <span style={{ color: '#888', fontSize: '0.75rem', marginRight: 4 }}>{p.position}</span>
              {p.playerName}
              <span style={{ color: '#888', fontSize: '0.75rem', marginLeft: 4 }}>{p.nhlTeam}</span>
            </span>
            <button
              disabled={queuedIds.has(p.playerId)}
              onClick={() => send({ type: 'queue_add', playerId: p.playerId, playerName: p.playerName, playerMeta: { position: p.position, nhlTeam: p.nhlTeam, headshotUrl: p.headshotUrl, crestUrl: p.crestUrl || '' } })}
              style={{ fontSize: '0.75rem', padding: '2px 6px' }}
            >
              {queuedIds.has(p.playerId) ? '✓' : '+ Queue'}
            </button>
            {isMyTurn && (
              <button
                onClick={() => send({ type: 'pick', playerId: p.playerId, playerName: p.playerName, playerMeta: { position: p.position, nhlTeam: p.nhlTeam, headshotUrl: p.headshotUrl, crestUrl: p.crestUrl || '' } })}
                style={{ fontSize: '0.75rem', padding: '2px 6px', background: '#27ae60', color: '#fff', border: 'none', cursor: 'pointer' }}
              >
                Draft
              </button>
            )}
          </div>
        ))}
        {filtered.length === 0 && <p className="st-dim">No players match.</p>}
      </div>
    </div>
  );
}

function DraftQueuePanel({ myQueue, send }) {
  const [dragging, setDragging] = useState(null);

  function onDragStart(e, idx) {
    setDragging(idx);
    e.dataTransfer.effectAllowed = 'move';
  }

  function onDrop(e, targetIdx) {
    e.preventDefault();
    if (dragging === null || dragging === targetIdx) return;
    const reordered = [...myQueue];
    const [item] = reordered.splice(dragging, 1);
    reordered.splice(targetIdx, 0, item);
    send({ type: 'queue_reorder', playerIds: reordered.map(p => p.playerId) });
    setDragging(null);
  }

  return (
    <div className="draft-queue">
      <h3 style={{ marginTop: 0 }}>My Queue</h3>
      {(!myQueue || myQueue.length === 0) && <p className="st-dim">Add players to your queue.</p>}
      {(myQueue || []).map((p, i) => (
        <div
          key={p.playerId}
          draggable
          onDragStart={e => onDragStart(e, i)}
          onDragOver={e => e.preventDefault()}
          onDrop={e => onDrop(e, i)}
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '4px 0', borderBottom: '1px solid #333', cursor: 'grab' }}
        >
          <span style={{ color: '#555', fontSize: '0.75rem', width: 16, textAlign: 'right' }}>{i + 1}</span>
          <span style={{ flex: 1, fontSize: '0.85rem' }}>
            <span style={{ color: '#888', fontSize: '0.7rem', marginRight: 4 }}>{p.position}</span>
            {p.playerName}
          </span>
          <button
            onClick={() => send({ type: 'queue_remove', playerId: p.playerId })}
            style={{ fontSize: '0.7rem', padding: '1px 5px', background: 'transparent', border: '1px solid #555', cursor: 'pointer' }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export default function DraftPage() {
  const { leagueId } = useParams();
  const { user } = useOutletContext();
  const [initialData, setInitialData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isCommissioner, setIsCommissioner] = useState(false);
  const { state: wsState, send, connected, error: wsError } = useDraftSocket(leagueId);

  useEffect(() => {
    async function load() {
      try {
        const [sessionData, teamsData] = await Promise.all([
          api.leagues.draft.getSession(leagueId),
          api.leagues.getTeams(leagueId),
        ]);
        setInitialData({ ...sessionData, teams: teamsData || [] });
        // Check commissioner status via teams list (user_id match against league ownership)
        // Actually check via the league object — use getSession ctx or leagueInfo
        // Simple approach: check if the user owns the league
        const leagueInfo = await api.leagues.get(leagueId);
        setIsCommissioner(leagueInfo?.owner_user_id === user?.id || leagueInfo?.my_role === 'commissioner');
      } catch {}
      setLoading(false);
    }
    load();
  }, [leagueId, user]);

  const [myTeamId2, setMyTeamId2] = useState(null);
  useEffect(() => {
    if (!initialData) return;
    const mine = (initialData.teams || []).find(t => t.user_id === user?.id);
    if (mine) setMyTeamId2(mine.id);
  }, [initialData, user]);

  if (loading) return <div className="page-content"><p>Loading draft…</p></div>;

  // Use WS state if connected, otherwise fall back to initialData
  const draftStatus = wsState?.status || initialData?.session?.status || null;

  if (!draftStatus || draftStatus === 'pending') {
    return (
      <div className="page-content">
        <PreDraftLobby
          leagueId={leagueId}
          initialSession={initialData?.session}
          isCommissioner={isCommissioner}
          onStart={() => window.location.reload()}
        />
      </div>
    );
  }

  // Use combined initialData + wsState (ws overrides once connected)
  const liveState = wsState || {
    status: initialData?.session?.status,
    currentPick: initialData?.session?.current_pick || 0,
    totalPicks: initialData?.session?.total_picks || 0,
    currentTeamId: null,
    pickDeadline: initialData?.session?.pick_deadline || null,
    draftOrder: initialData?.session?.draft_order || [],
    picks: (initialData?.picks || []).map(p => ({
      ...p, ...p.player_meta,
      teamId: p.team_id, teamName: p.team_name,
      playerId: p.player_id, playerName: p.player_name,
      overallPick: p.overall_pick, pickInRound: p.pick_in_round,
      isAutoPick: !!p.is_auto_pick, pickedAt: p.picked_at,
    })),
    myQueue: (initialData?.myQueue || []).map(q => ({
      ...q.player_meta,
      playerId: q.player_id, playerName: q.player_name,
    })),
    available: [],
  };

  const onClockTeam = liveState.draftOrder.find(t => t.teamId === liveState.currentTeamId);

  return (
    <div className="page-content">
      {wsError && <p className="alert">{wsError}</p>}
      {!connected && liveState.status === 'active' && <p className="st-dim">Reconnecting…</p>}

      <DraftTimerBar
        pickDeadline={liveState.pickDeadline}
        status={liveState.status}
        teamName={onClockTeam?.teamName}
      />

      {liveState.status === 'completed' && (
        <p style={{ color: '#27ae60', fontWeight: 'bold', margin: '0.5rem 0' }}>Draft Complete!</p>
      )}

      {isCommissioner && liveState.status === 'active' && (
        <button onClick={() => api.leagues.draft.pause(leagueId)} style={{ marginTop: '0.5rem' }}>Pause Draft</button>
      )}
      {isCommissioner && liveState.status === 'paused' && (
        <button onClick={() => api.leagues.draft.resume(leagueId)} style={{ marginTop: '0.5rem' }}>Resume Draft</button>
      )}

      <div style={{ marginTop: '1rem' }}>
        <DraftBoardGrid
          draftOrder={liveState.draftOrder}
          picks={liveState.picks}
          currentPick={liveState.currentPick}
          totalPicks={liveState.totalPicks}
          currentTeamId={liveState.currentTeamId}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1rem' }}>
        <DraftAvailablePlayers
          available={liveState.available}
          myQueue={liveState.myQueue}
          currentTeamId={liveState.currentTeamId}
          myTeamId={myTeamId2}
          status={liveState.status}
          send={send}
        />
        <DraftQueuePanel
          myQueue={liveState.myQueue}
          send={send}
        />
      </div>
    </div>
  );
}
