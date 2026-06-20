import { useState, useEffect } from 'react';
import { useParams, useOutletContext } from 'react-router-dom';
import { api } from '../api';
import { useAuctionSocket } from '../hooks/useAuctionSocket';

function PreAuctionLobby({ leagueId, initialSession, isCommissioner, onStart }) {
  const [draftOrder, setDraftOrder] = useState(
    initialSession?.draft_order || []
  );
  const [msg, setMsg] = useState('');

  async function createSession() {
    try {
      await api.leagues.auction.create(leagueId);
      const data = await api.leagues.auction.getSession(leagueId);
      setDraftOrder(data?.session?.draft_order || []);
      setMsg('Session created.');
    } catch (e) { setMsg(e.message); }
  }

  async function randomize() {
    try {
      const data = await api.leagues.auction.randomize(leagueId);
      setDraftOrder(data?.order || []);
      setMsg('Order randomized.');
    } catch (e) { setMsg(e.message); }
  }

  async function startAuction() {
    try {
      await api.leagues.auction.start(leagueId);
      onStart();
    } catch (e) { setMsg(e.message); }
  }

  const allSlotsFilled = draftOrder.length > 0 && draftOrder.every(t => t.teamId);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Auction Draft Setup</h2>

      {isCommissioner ? (
        <>
          {!initialSession && (
            <button onClick={createSession} style={{ marginBottom: '1rem' }}>
              Create Auction Session
            </button>
          )}

          {initialSession && (
            <>
              <div style={{ marginBottom: '1rem' }}>
                <h3>Draft Order</h3>
                {draftOrder.length === 0 && <p className="st-dim">No order set yet.</p>}
                <ol>
                  {draftOrder.map((t, i) => (
                    <li key={t.teamId}>{t.teamName}</li>
                  ))}
                </ol>
                <button onClick={randomize} style={{ marginRight: '0.5rem' }}>
                  Randomize Order
                </button>
              </div>

              <button
                onClick={startAuction}
                disabled={!allSlotsFilled}
                style={{ opacity: allSlotsFilled ? 1 : 0.5 }}
              >
                Start Auction
              </button>
            </>
          )}

          {msg && <p style={{ color: '#e67e22', marginTop: '0.5rem' }}>{msg}</p>}
        </>
      ) : (
        <p className="st-dim">Waiting for the commissioner to start the auction.</p>
      )}
    </div>
  );
}

function AuctionTimerBar({ bidDeadline, status, nominatorName }) {
  const [secsLeft, setSecsLeft] = useState(null);

  useEffect(() => {
    if (status === 'completed') { setSecsLeft(null); return; }
    if (!bidDeadline) { setSecsLeft(null); return; }
    const tick = () => {
      const diff = Math.max(0, Math.floor((new Date(bidDeadline) - Date.now()) / 1000));
      setSecsLeft(diff);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [bidDeadline, status]);

  if (status === 'paused') return <div style={{ background: '#e67e22', padding: '6px 12px', borderRadius: 4, color: '#fff', fontWeight: 'bold', marginBottom: '0.75rem' }}>PAUSED</div>;
  if (status === 'completed' || secsLeft === null) return null;

  const color = secsLeft <= 5 ? '#e74c3c' : secsLeft <= 10 ? '#e67e22' : '#27ae60';
  return (
    <div style={{ marginBottom: '0.75rem' }}>
      {nominatorName && <span style={{ color: '#888', fontSize: '0.85rem' }}>On the clock: {nominatorName} — </span>}
      <span style={{ color, fontWeight: 'bold', fontSize: '1.1rem' }}>{secsLeft}s</span>
    </div>
  );
}

function NominationPanel({ nomination, draftOrder }) {
  if (!nomination) return <div style={{ padding: '1rem', border: '1px solid #333', borderRadius: 6, textAlign: 'center', color: '#888' }}>Waiting for nomination…</div>;

  const bidderName = draftOrder.find(t => t.teamId === nomination.currentBidderId)?.teamName || 'Unknown';
  return (
    <div style={{ padding: '1rem', border: '2px solid #f1c40f', borderRadius: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        {nomination.playerMeta?.headshotUrl && (
          <img src={nomination.playerMeta.headshotUrl} alt="" style={{ width: 48, height: 48, borderRadius: '50%' }} />
        )}
        <div>
          <div style={{ fontWeight: 'bold', fontSize: '1.1rem' }}>{nomination.playerName}</div>
          <div style={{ color: '#888', fontSize: '0.8rem' }}>
            {nomination.playerMeta?.position} · {nomination.playerMeta?.nhlTeam}
          </div>
        </div>
      </div>
      <div style={{ marginTop: '0.75rem', fontSize: '1.4rem', fontWeight: 'bold', color: '#f1c40f' }}>
        ${nomination.currentBid}
        <span style={{ fontSize: '0.85rem', color: '#888', fontWeight: 'normal', marginLeft: 8 }}>
          — {bidderName}
        </span>
      </div>
    </div>
  );
}

function NominatePanel({ available, myBudget, myRoster, capsF, capsD, capsG, send }) {
  const [search, setSearch] = useState('');
  const [openingBid, setOpeningBid] = useState(1);

  const rosterTotal = (myRoster?.F || 0) + (myRoster?.D || 0) + (myRoster?.G || 0);
  const remainingSlots = capsF + capsD + capsG - rosterTotal;
  const maxBid = Math.max(1, (myBudget ?? 0) - remainingSlots + 1);

  const filtered = (available || []).filter(p =>
    !search || p.playerName.toLowerCase().includes(search.toLowerCase())
  );

  function nominate(p) {
    send({
      type: 'nominate',
      playerId: p.playerId,
      playerName: p.playerName,
      playerMeta: { position: p.position, nhlTeam: p.nhlTeam, headshotUrl: p.headshotUrl, crestUrl: p.crestUrl || '' },
      openingBid: Number(openingBid),
    });
  }

  return (
    <div style={{ border: '1px solid #2ecc71', borderRadius: 6, padding: '0.75rem' }}>
      <h4 style={{ marginTop: 0, color: '#2ecc71' }}>Your turn to nominate</h4>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <input
          placeholder="Search players…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1 }}
        />
        <input
          type="number"
          min={1}
          max={maxBid}
          value={openingBid}
          onChange={e => setOpeningBid(e.target.value)}
          style={{ width: 70 }}
        />
      </div>
      <div style={{ maxHeight: 200, overflowY: 'auto' }}>
        {filtered.slice(0, 50).map(p => (
          <div key={p.playerId} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '3px 0', borderBottom: '1px solid #333' }}>
            <span style={{ flex: 1, fontSize: '0.85rem' }}>
              <span style={{ color: '#888', fontSize: '0.75rem', marginRight: 4 }}>{p.position}</span>
              {p.playerName}
            </span>
            <button onClick={() => nominate(p)} style={{ fontSize: '0.75rem', padding: '2px 8px' }}>
              Nominate
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function TeamsSidebar({ draftOrder, budgets, rosters, capsF, capsD, capsG }) {
  const budgetMap = Object.fromEntries((budgets || []).map(b => [b.teamId, b.budgetRemaining]));
  const rosterMap = Object.fromEntries((rosters || []).map(r => [r.teamId, r]));
  const totalSlots = capsF + capsD + capsG;

  return (
    <div style={{ border: '1px solid #333', borderRadius: 6, padding: '0.75rem' }}>
      <h4 style={{ marginTop: 0 }}>Teams</h4>
      {(draftOrder || []).map(t => {
        const r = rosterMap[t.teamId] || { F: 0, D: 0, G: 0 };
        const filled = r.F + r.D + r.G;
        const budget = budgetMap[t.teamId] ?? '—';
        return (
          <div key={t.teamId} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #222', fontSize: '0.85rem' }}>
            <span>{t.teamName}</span>
            <span style={{ color: '#888' }}>${budget} · {filled}/{totalSlots}</span>
          </div>
        );
      })}
    </div>
  );
}

function PicksFeed({ picks, draftOrder }) {
  const teamMap = Object.fromEntries((draftOrder || []).map(t => [t.teamId, t.teamName]));
  const sorted = [...(picks || [])].reverse();
  return (
    <div style={{ border: '1px solid #333', borderRadius: 6, padding: '0.75rem', maxHeight: 300, overflowY: 'auto' }}>
      <h4 style={{ marginTop: 0 }}>Picks</h4>
      {sorted.length === 0 && <p className="st-dim">No picks yet.</p>}
      {sorted.map(p => (
        <div key={p.pick_number || p.pickNumber} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid #222', fontSize: '0.82rem' }}>
          <span>
            <span style={{ color: '#888', fontSize: '0.7rem', marginRight: 4 }}>{p.playerMeta?.position || p.player_meta?.position}</span>
            {p.playerName || p.player_name}
          </span>
          <span style={{ color: '#888' }}>{teamMap[p.teamId || p.team_id]} · <span style={{ color: '#f1c40f' }}>${p.amount}</span></span>
        </div>
      ))}
    </div>
  );
}

export default function AuctionPage() {
  const { leagueId } = useParams();
  const { user } = useOutletContext();
  const [initialData, setInitialData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isCommissioner, setIsCommissioner] = useState(false);
  const [myTeamId, setMyTeamId] = useState(null);
  const { state: wsState, send, connected, error: wsError } = useAuctionSocket(leagueId);

  useEffect(() => {
    async function load() {
      try {
        const [sessionData, teamsData, leagueInfo] = await Promise.all([
          api.leagues.auction.getSession(leagueId),
          api.leagues.getTeams(leagueId),
          api.leagues.get(leagueId),
        ]);
        setInitialData({ ...sessionData, teams: teamsData || [] });
        setIsCommissioner(leagueInfo?.owner_user_id === user?.id || leagueInfo?.my_role === 'commissioner');
        const mine = (teamsData || []).find(t => t.user_id === user?.id);
        if (mine) setMyTeamId(mine.id);
      } catch {}
      setLoading(false);
    }
    load();
  }, [leagueId, user]);

  if (loading) return <div className="page-content"><p>Loading auction…</p></div>;

  const auctionStatus = wsState?.status || initialData?.session?.status || null;

  if (!auctionStatus || auctionStatus === 'pending') {
    return (
      <div className="page-content">
        <PreAuctionLobby
          leagueId={leagueId}
          initialSession={initialData?.session}
          isCommissioner={isCommissioner}
          onStart={() => window.location.reload()}
        />
      </div>
    );
  }

  const liveState = wsState || {
    status: initialData?.session?.status,
    nominatorIdx: initialData?.session?.current_nominator_idx || 0,
    currentNominatorTeamId: null,
    currentNomination: initialData?.session?.current_nomination,
    draftOrder: initialData?.session?.draft_order || [],
    picks: initialData?.picks || [],
    budgets: [],
    rosters: [],
    available: [],
    myBudget: initialData?.myBudget ?? null,
    myRoster: myTeamId ? null : null,
  };

  const capsF = 10; const capsD = 5; const capsG = 3;
  const isMyTurn = myTeamId && liveState.currentNominatorTeamId === myTeamId && liveState.status === 'active';
  const nomination = liveState.currentNomination;
  const nominatorName = liveState.draftOrder.find(t => t.teamId === liveState.currentNominatorTeamId)?.teamName;

  // Bid controls
  const nextBidAmount = (nomination?.currentBid || 0) + 1;
  const myRoster = liveState.rosters?.find?.(r => r.teamId === myTeamId) || liveState.myRoster || { F: 0, D: 0, G: 0 };
  const myBudget = liveState.myBudget ?? (liveState.budgets?.find?.(b => b.teamId === myTeamId)?.budgetRemaining ?? null);
  const rosterTotal = (myRoster?.F || 0) + (myRoster?.D || 0) + (myRoster?.G || 0);
  const remainingSlots = capsF + capsD + capsG - rosterTotal;
  const myMaxBid = myBudget != null ? myBudget - remainingSlots + 1 : 0;
  const nomPos = (nomination?.playerMeta?.position || 'F').toUpperCase();
  const myPosCount = myRoster?.[nomPos] || 0;
  const myPosCap = nomPos === 'G' ? capsG : nomPos === 'D' ? capsD : capsF;
  const canBid = nomination &&
    liveState.status === 'active' &&
    myTeamId &&
    remainingSlots > 0 &&
    myPosCount < myPosCap &&
    nextBidAmount <= myMaxBid &&
    nomination.currentBidderId !== myTeamId;

  return (
    <div className="page-content">
      {wsError && <p className="alert">{wsError}</p>}
      {!connected && liveState.status === 'active' && <p className="st-dim">Reconnecting…</p>}

      <AuctionTimerBar
        bidDeadline={nomination?.bidDeadline}
        status={liveState.status}
        nominatorName={nominatorName}
      />

      {liveState.status === 'completed' && (
        <p style={{ color: '#27ae60', fontWeight: 'bold', margin: '0.5rem 0' }}>Auction Complete!</p>
      )}

      {isCommissioner && liveState.status === 'active' && (
        <button onClick={() => api.leagues.auction.pause(leagueId)} style={{ marginBottom: '0.75rem' }}>Pause Auction</button>
      )}
      {isCommissioner && liveState.status === 'paused' && (
        <button onClick={() => api.leagues.auction.resume(leagueId)} style={{ marginBottom: '0.75rem' }}>Resume Auction</button>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: '1rem' }}>
        <div>
          <NominationPanel nomination={nomination} draftOrder={liveState.draftOrder} />

          {canBid && (
            <div style={{ marginTop: '0.75rem' }}>
              <button
                onClick={() => send({ type: 'bid', amount: nextBidAmount })}
                style={{ fontSize: '1rem', padding: '0.5rem 1.5rem', background: '#2980b9', border: 'none', color: '#fff', borderRadius: 4, cursor: 'pointer' }}
              >
                Bid ${nextBidAmount}
              </button>
            </div>
          )}

          {isMyTurn && !nomination && (
            <div style={{ marginTop: '0.75rem' }}>
              <NominatePanel
                available={liveState.available}
                myBudget={myBudget}
                myRoster={myRoster}
                capsF={capsF} capsD={capsD} capsG={capsG}
                send={send}
              />
            </div>
          )}

          <div style={{ marginTop: '1rem' }}>
            <PicksFeed picks={liveState.picks} draftOrder={liveState.draftOrder} />
          </div>
        </div>

        <div>
          {myBudget != null && (
            <div style={{ border: '1px solid #333', borderRadius: 6, padding: '0.75rem', marginBottom: '1rem' }}>
              <div style={{ fontSize: '0.85rem', color: '#888' }}>My Budget</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 'bold', color: '#f1c40f' }}>${myBudget}</div>
              <div style={{ fontSize: '0.75rem', color: '#888' }}>{remainingSlots} slots remaining</div>
            </div>
          )}
          <TeamsSidebar
            draftOrder={liveState.draftOrder}
            budgets={liveState.budgets}
            rosters={liveState.rosters}
            capsF={capsF} capsD={capsD} capsG={capsG}
          />
        </div>
      </div>
    </div>
  );
}
