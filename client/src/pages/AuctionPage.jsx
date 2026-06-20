import { useParams } from 'react-router-dom';

export default function AuctionPage() {
  const { leagueId } = useParams();
  return (
    <div className="page-content">
      <p>Auction — league {leagueId} — coming soon</p>
    </div>
  );
}
