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
        setInitialData(sessionData);
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

  // Active / paused / completed — rendered in Task 7
  return (
    <div className="page-content">
      <p>Draft status: {draftStatus}</p>
      {wsError && <p className="alert">{wsError}</p>}
      {!connected && <p className="st-dim">Reconnecting…</p>}
    </div>
  );
}
