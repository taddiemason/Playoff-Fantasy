import { useParams, useOutletContext, Link } from 'react-router-dom'

export default function LeagueRules() {
  const { leagueId } = useParams()
  const { league } = useOutletContext()
  const c = league.config
  const sk = c.scoring.skater
  const go = c.scoring.goalie

  return (
    <div>
      <Link to={`/leagues/${leagueId}`} className="back-link">← {league.name}</Link>
      <div className="page-header">
        <div className="page-title">League Rules</div>
      </div>

      {c.description && (
        <div className="league-description"><p>{c.description}</p></div>
      )}

      <div className="rules-page-grid">
        <div className="card rules-card">
          <div className="rules-card-title">Skater Scoring (F &amp; D)</div>
          <div className="rule-item"><span>Goal</span><span className="rule-pts">+{sk.goal}</span></div>
          <div className="rule-item"><span>Assist</span><span className="rule-pts">+{sk.assist}</span></div>
          <div className="rule-item"><span>Special Teams Point (bonus)</span><span className="rule-pts">+{sk.specialTeamsPointBonus}</span></div>
          <div className="rule-item"><span>Penalty Minute</span><span className="rule-pts">+{sk.pim}</span></div>
          <div className="rule-item"><span>Plus / Minus</span><span className="rule-pts">actual</span></div>
        </div>

        <div className="card rules-card">
          <div className="rules-card-title">Goalie Scoring</div>
          <div className="rule-item"><span>Win</span><span className="rule-pts">+{go.win}</span></div>
          <div className="rule-item"><span>Shutout</span><span className="rule-pts">+{go.shutout}</span></div>
          <div className="rule-item"><span>GAA Rank</span><span className="rule-pts">{go.gaaRank ? 'ranked' : 'off'}</span></div>
          <div className="rule-item"><span>SV% Rank</span><span className="rule-pts">{go.svpRank ? 'ranked' : 'off'}</span></div>
          <div className="rules-note">
            Goalie ranking: among all goalies rostered in this league, the best GAA/SV% earns N points,
            second-best N−1, and so on (N = number of league goalies).
          </div>
        </div>

        <div className="card rules-card">
          <div className="rules-card-title">Roster Sizes</div>
          <div className="rule-item"><span>Forwards</span><span className="rule-pts">{c.roster.maxF}</span></div>
          <div className="rule-item"><span>Defensemen</span><span className="rule-pts">{c.roster.maxD}</span></div>
          <div className="rule-item"><span>Goalies</span><span className="rule-pts">{c.roster.maxG}</span></div>
          <div className="rule-item"><span>Max per NHL team (F)</span><span className="rule-pts">{c.roster.maxSameTeamF}</span></div>
          <div className="rule-item"><span>Max per NHL team (D)</span><span className="rule-pts">{c.roster.maxSameTeamD}</span></div>
        </div>

        <div className="card rules-card">
          <div className="rules-card-title">Lock Rules</div>
          <div className="rules-note">{c.lock.rule}</div>
          <div className="rule-item" style={{ marginTop: 8 }}>
            <span>Current status</span>
            <span className="rule-pts" style={{ color: league.is_locked ? 'var(--red)' : 'var(--green)' }}>
              {league.is_locked ? 'Locked' : 'Open'}
            </span>
          </div>
          <div className="rules-note" style={{ marginTop: 8 }}>
            Once a player’s NHL team is eliminated, that roster spot is dead — no replacements.
          </div>
        </div>

        <div className="card rules-card">
          <div className="rules-card-title">Tiebreaker</div>
          <div className="rules-note">
            If two teams finish tied on points, the win goes to the closest guess of the Stanley Cup–winning
            goalie’s total playoff save percentage (to 4 decimals, e.g. .9145). Set yours on your team page.
          </div>
        </div>

        <div className="card rules-card">
          <div className="rules-card-title">Payout Structure</div>
          {c.payout.map((tier, i) => (
            <div className="rule-item" key={i}>
              <span>{tier.minEntries === 0 ? 'Base' : `${tier.minEntries}+ entries`}</span>
              <span className="rule-pts">{tier.split}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
