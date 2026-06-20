import { useParams } from 'react-router-dom';

export default function KeepersPage() {
  const { leagueId } = useParams();
  return (
    <div className="page-content">
      <p>Keepers — league {leagueId} — coming soon</p>
    </div>
  );
}
