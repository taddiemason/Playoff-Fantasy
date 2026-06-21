const STATUS_COLORS = {
  IR:   '#ef4444',
  LTIR: '#ef4444',
  OUT:  '#991b1b',
  DTD:  '#f97316',
};

export default function PlayerStatusBadge({ injuryStatus, injuryDescription }) {
  if (!injuryStatus) return null;
  const bg = STATUS_COLORS[injuryStatus] || '#6b7280';
  return (
    <span
      className="player-status-badge"
      style={{ backgroundColor: bg }}
      title={injuryDescription || injuryStatus}
    >
      {injuryStatus}
    </span>
  );
}
