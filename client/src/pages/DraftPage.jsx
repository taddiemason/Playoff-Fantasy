import { useParams } from 'react-router-dom';

export default function DraftPage() {
  const { leagueId } = useParams();
  return <div className="page-content"><p>Draft — league {leagueId} — coming soon</p></div>;
}
