interface CouncilSummary {
  id: string;
  name: string;
  description: string;
  agentCount: number;
  active: boolean;
}

interface Props {
  councils: CouncilSummary[];
  selectedCouncilId: string | null;
  onSelect: (councilId: string | null) => void;
}

export function CouncilSelector({ councils, selectedCouncilId, onSelect }: Props) {
  if (councils.length <= 1) return null;

  return (
    <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
      <label style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>
        Council
      </label>
      <select
        value={selectedCouncilId ?? ''}
        onChange={(e) => {
          const val = (e.target as HTMLSelectElement).value;
          onSelect(val || null);
        }}
        style={{
          width: '100%',
          padding: '6px 8px',
          fontSize: 13,
          background: 'var(--surface-2)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          cursor: 'pointer',
        }}
      >
        <option value="">All Councils</option>
        {councils.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.agentCount} agents)
          </option>
        ))}
      </select>
    </div>
  );
}
