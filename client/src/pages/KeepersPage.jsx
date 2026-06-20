import { useState, useEffect } from 'react';
import { useParams, useOutletContext } from 'react-router-dom';
import { api } from '../api';

function CostBadge({ costType, costValue }) {
  if (costType === 'free') return <span style={{ color: '#27ae60', fontSize: '0.75rem' }}>Free</span>;
  if (costType === 'none') return <span style={{ color: '#888', fontSize: '0.75rem' }}>Manual</span>;
  if (costType === 'pick_round') return <span style={{ color: '#e67e22', fontSize: '0.75rem' }}>Round {costValue || '—'}</span>;
  if (costType === 'auction_inflation') return <span style={{ color: '#e67e22', fontSize: '0.75rem' }}>${costValue || '—'}</span>;
  return null;
}

function TeamOwnerView({ leagueId, keeperData, phase }) {
  const { myRoster, designations, config } = keeperData;
  const { maxKeepers, keeperCostType } = config;
  const myDesignatedIds = new Set(designations.map(d => d.player_id));

  const [selected, setSelected] = useState(() => new Set(myDesignatedIds));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const isOpen = phase === 'keeper_window';

  function toggle(playerId) {
    if (!isOpen) return;
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(playerId)) { next.delete(playerId); } else {
        if (next.size >= maxKeepers) { setMsg(`Maximum ${maxKeepers} keepers allowed`); return prev; }
        next.add(playerId);
      }
      setMsg('');
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setMsg('');
    try {
      const keepers = myRoster
        .filter(p => selected.has(p.player_id))
        .map(p => ({
          playerId: p.player_id,
          playerName: p.player_name,
          playerMeta: { position: p.position, nhlTeam: p.nhl_team, headshotUrl: p.headshot_url || '', crestUrl: p.crest_url || '' },
        }));
      await api.leagues.keepers.set(leagueId, keepers);
      setMsg('Keepers saved.');
    } catch (e) { setMsg(e.message); }
    setSaving(false);
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <h3 style={{ margin: 0 }}>Your Keepers</h3>
        <span style={{ color: '#888', fontSize: '0.85rem' }}>{selected.size} / {maxKeepers} designated</span>
      </div>

      {!isOpen && (
        <p style={{ color: '#888', marginBottom: '1rem' }}>
          {phase === 'offseason' ? 'Keeper window not yet open.' : 'Keeper window is closed.'}
        </p>
      )}

      {myRoster.length === 0 && <p style={{ color: '#888' }}>No players on your roster.</p>}

      {myRoster.map(p => {
        const isKeeper = selected.has(p.player_id);
        return (
          <div
            key={p.player_id}
            onClick={() => toggle(p.player_id)}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.75rem',
              padding: '8px 12px', marginBottom: 4,
              border: `1px solid ${isKeeper ? '#27ae60' : '#333'}`,
              borderRadius: 6, cursor: isOpen ? 'pointer' : 'default',
              background: isKeeper ? 'rgba(39,174,96,0.08)' : 'transparent',
            }}
          >
            {p.headshot_url && <img src={p.headshot_url} alt="" style={{ width: 32, height: 32, borderRadius: '50%' }} />}
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: isKeeper ? 'bold' : 'normal' }}>{p.player_name}</div>
              <div style={{ fontSize: '0.75rem', color: '#888' }}>{p.position} · {p.nhl_team}</div>
            </div>
            <CostBadge costType={keeperCostType} costValue={p.costValue} />
            {isKeeper && <span style={{ color: '#27ae60', fontSize: '0.8rem' }}>✓ Keeping</span>}
          </div>
        );
      })}

      {isOpen && (
        <div style={{ marginTop: '1rem' }}>
          <button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Keepers'}</button>
          {msg && <span style={{ marginLeft: '0.75rem', color: msg.includes('saved') ? '#27ae60' : '#e74c3c', fontSize: '0.85rem' }}>{msg}</span>}
        </div>
      )}
    </div>
  );
}

function CommissionerView({ keeperData }) {
  const { teams, config, designations } = keeperData;
  const { maxKeepers } = config;
  const countMap = {};
  for (const d of designations) {
    countMap[d.team_id] = (countMap[d.team_id] || 0) + 1;
  }
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Keeper Designations — All Teams</h3>
      {teams.map(t => {
        const count = countMap[t.id] || 0;
        const ready = count === maxKeepers;
        return (
          <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #222' }}>
            <span>{t.name}</span>
            <span style={{ color: ready ? '#27ae60' : '#888' }}>{count} / {maxKeepers}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function KeepersPage() {
  const { leagueId } = useParams();
  const { league } = useOutletContext();
  const [keeperData, setKeeperData] = useState(null);
  const [loading, setLoading] = useState(true);

  const isCommissioner = league?.role === 'commissioner';

  useEffect(() => {
    api.leagues.keepers.get(leagueId)
      .then(d => setKeeperData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [leagueId]);

  if (loading) return <div className="page-content"><p>Loading keepers…</p></div>;
  if (!keeperData) return <div className="page-content"><p>Could not load keeper data.</p></div>;

  return (
    <div className="page-content">
      {isCommissioner
        ? <CommissionerView keeperData={keeperData} />
        : <TeamOwnerView leagueId={leagueId} keeperData={keeperData} phase={league?.phase} />
      }
    </div>
  );
}
