import { useState } from 'preact/hooks';
import type { Session, SessionPhase } from '../../shared/types.js';

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

const allPhases: (SessionPhase | 'all')[] = [
  'all', 'investigation', 'proposal', 'discussion', 'refinement', 'voting', 'review', 'decided', 'closed',
];

interface Props {
  sessions: Session[];
  onSelect: (id: string) => void;
}

export function SessionList({ sessions, onSelect }: Props) {
  const [phaseFilter, setPhaseFilter] = useState<SessionPhase | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const createSession = async () => {
    const title = prompt('Session title:');
    if (!title) return;
    await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
  };

  const filtered = sessions.filter((s) => {
    if (phaseFilter !== 'all' && s.phase !== phaseFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q);
    }
    return true;
  });

  const selectStyle = {
    padding: '6px 10px',
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--text)',
    fontSize: 13,
    fontFamily: 'var(--font)',
    outline: 'none',
    appearance: 'auto' as const,
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
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

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Search by title or ID..."
          value={searchQuery}
          onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
          style={{
            flex: 1,
            minWidth: 200,
            padding: '6px 12px',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text)',
            fontSize: 13,
            fontFamily: 'var(--font)',
            outline: 'none',
          }}
        />
        <select
          value={phaseFilter}
          onChange={(e) => setPhaseFilter((e.target as HTMLSelectElement).value as SessionPhase | 'all')}
          style={selectStyle}
        >
          {allPhases.map((p) => (
            <option key={p} value={p}>{p === 'all' ? 'All phases' : p}</option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <p style={{ color: 'var(--text-dim)', padding: 40, textAlign: 'center' }}>
          {sessions.length === 0
            ? 'No sessions yet. Create one manually or trigger via webhook.'
            : 'No sessions match your filters.'
          }
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map((session) => (
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
