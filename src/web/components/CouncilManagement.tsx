import { useState } from 'preact/hooks';

interface CouncilSummary {
  id: string;
  name: string;
  description: string;
  agentCount: number;
  active: boolean;
  createdAt: string;
}

interface Props {
  councils: CouncilSummary[];
  onCouncilCreated: () => void;
  onCouncilDeleted: () => void;
}

export function CouncilManagement({ councils, onCouncilCreated, onCouncilDeleted }: Props) {
  const [yaml, setYaml] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!yaml.trim()) {
      setError('YAML config is required');
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const res = await fetch('/api/councils', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to create council');
        return;
      }

      setYaml('');
      onCouncilCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (councilId: string) => {
    if (!confirm('Delete this council? This cannot be undone.')) return;

    try {
      const res = await fetch(`/api/councils/${councilId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || 'Failed to delete council');
        return;
      }
      onCouncilDeleted();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text)' }}>Councils</h2>
      </div>

      {/* Council list */}
      <div style={{ marginBottom: 32 }}>
        {councils.map((c) => (
          <div
            key={c.id}
            style={{
              padding: '16px',
              borderRadius: 'var(--radius)',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              marginBottom: 8,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div>
              <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: 14 }}>
                {c.name}
                {c.active && (
                  <span style={{
                    marginLeft: 8,
                    fontSize: 11,
                    padding: '1px 6px',
                    borderRadius: 10,
                    background: 'var(--success)',
                    color: '#fff',
                  }}>
                    Active
                  </span>
                )}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 4 }}>
                {c.description}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
                {c.agentCount} agent{c.agentCount !== 1 ? 's' : ''} &middot; {c.id.slice(0, 12)}...
              </div>
            </div>
            <button
              onClick={() => handleDelete(c.id)}
              style={{
                background: 'none',
                border: '1px solid var(--danger)',
                color: 'var(--danger)',
                padding: '4px 12px',
                borderRadius: 'var(--radius)',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              Delete
            </button>
          </div>
        ))}
        {councils.length === 0 && (
          <div style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>No councils configured.</div>
        )}
      </div>

      {/* Create council */}
      <div style={{
        padding: 16,
        borderRadius: 'var(--radius)',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
      }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)', marginBottom: 12 }}>
          Create Council
        </h3>
        <textarea
          value={yaml}
          onInput={(e) => setYaml((e.target as HTMLTextAreaElement).value)}
          placeholder="Paste YAML council config here..."
          style={{
            width: '100%',
            minHeight: 200,
            padding: 12,
            fontSize: 13,
            fontFamily: 'monospace',
            background: 'var(--surface-2)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            resize: 'vertical',
            boxSizing: 'border-box',
          }}
        />
        {error && (
          <div style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</div>
        )}
        <button
          onClick={handleCreate}
          disabled={creating}
          style={{
            marginTop: 12,
            padding: '8px 16px',
            fontSize: 14,
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            borderRadius: 'var(--radius)',
            cursor: creating ? 'wait' : 'pointer',
            opacity: creating ? 0.7 : 1,
          }}
        >
          {creating ? 'Creating...' : 'Create Council'}
        </button>
      </div>
    </div>
  );
}
