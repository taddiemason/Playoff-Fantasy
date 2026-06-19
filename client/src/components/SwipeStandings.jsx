import { useNavigate } from 'react-router-dom'

const MEDALS = ['1', '2', '3']

// Compact, swipeable standings for mobile — horizontal scroll-snap carousel,
// one card per team. Shown only on narrow screens (see .mobile-only in CSS).
export default function SwipeStandings({ rows, leagueId }) {
  const navigate = useNavigate()
  return (
    <div className="swipe-standings">
      <div className="swipe-hint">← swipe through teams →</div>
      <div className="swipe-track">
        {rows.map((t, i) => (
          <div
            key={t.id}
            className={`swipe-card rank-${i + 1 <= 3 ? i + 1 : 'n'}`}
            onClick={() => navigate(`/leagues/${leagueId}/teams/${t.id}`)}
          >
            <div className="swipe-rank">{i + 1 <= 3 ? MEDALS[i] : `#${i + 1}`}</div>
            <div className="swipe-name">{t.name}</div>
            {t.owner && <div className="swipe-owner">{t.owner}</div>}
            <div className="swipe-points">{t.totalPoints}<span>pts</span></div>
            <div className="swipe-meta">
              <div><span>{t.active}/{t.total}</span><label>active</label></div>
              <div><span className={t.dead > 0 ? 'st-danger' : ''}>{t.dead}</span><label>dead</label></div>
              <div><span>{t.skaterPts}</span><label>skater</label></div>
              <div><span>{t.goaliePts}</span><label>goalie</label></div>
            </div>
            <div className="swipe-tap">Tap for roster →</div>
          </div>
        ))}
      </div>
    </div>
  )
}
