import type { Session } from '../../shared/types.js';

const phaseColors: Record<string, string> = {
  investigation: 'var(--info)',
  proposal: 'var(--accent)',
  discussion: 'var(--warning)',
  refinement: '#f59e0b',
  voting: '#c084fc',
  review: 'var(--danger)',
  decided: 'var(--success)',
  closed: 'var(--text-dim)',
};

interface Props {
  sessions: Session[];
  onSelect: (id: string) => void;
}

export function SessionList({ sessions, onSelect }: Props) {
  const createSession = async () => {
    const title = prompt('Session title:');
    if (!title) return;
    await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600 }}>Sessions</h2>
        <button
          onClick={createSession}
          style={{
            padding: '8px 16px',
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            borderRadius: 'var(--radius)',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          New Session
        </button>
      </div>

      {sessions.length === 0 ? (
        <p style={{ color: 'var(--text-dim)', padding: 40, textAlign: 'center' }}>
          No sessions yet. Create one manually or trigger via webhook.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => onSelect(session.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 18px',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                cursor: 'pointer',
                textAlign: 'left',
                color: 'var(--text)',
                width: '100%',
              }}
            >
              <div>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>{session.title}</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                  {session.id.slice(0, 8)} &middot; Round {session.deliberationRound} &middot; {new Date(session.createdAt).toLocaleDateString()}
                </div>
              </div>
              <span style={{
                padding: '3px 10px',
                borderRadius: 12,
                fontSize: 12,
                fontWeight: 500,
                background: `${phaseColors[session.phase] ?? 'var(--text-dim)'}22`,
                color: phaseColors[session.phase] ?? 'var(--text-dim)',
              }}>
                {session.phase}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
