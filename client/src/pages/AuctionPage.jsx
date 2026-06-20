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

  // Active/paused/completed — Task 7 will replace this stub
  return (
    <div className="page-content">
      <p>Auction is live — status: {auctionStatus}</p>
    </div>
  );
}
