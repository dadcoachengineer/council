import type { Vote } from '../../shared/types.js';

interface Props {
  votes: Vote[];
  totalAgents: number;
}

const voteColors: Record<string, string> = {
  approve: 'var(--success)',
  consent: 'var(--success)',
  reject: 'var(--danger)',
  object: 'var(--danger)',
  abstain: 'var(--warning)',
};

export function VoteBar({ votes, totalAgents }: Props) {
  if (totalAgents === 0) return null;

  const counts: Record<string, Vote[]> = {};
  for (const v of votes) {
    const key = v.value;
    if (!counts[key]) counts[key] = [];
    counts[key].push(v);
  }

  const pending = totalAgents - votes.length;
  const segments: { color: string; label: string; count: number; agents: string[] }[] = [];

  for (const [value, voteList] of Object.entries(counts)) {
    segments.push({
      color: voteColors[value] ?? 'var(--text-dim)',
      label: value,
      count: voteList.length,
      agents: voteList.map((v) => v.agentId),
    });
  }

  if (pending > 0) {
    segments.push({
      color: 'var(--surface-2)',
      label: 'pending',
      count: pending,
      agents: [],
    });
  }

  return (
    <div style={{ marginBottom: 16 }}>
      {/* Bar */}
      <div style={{
        display: 'flex',
        height: 28,
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
        border: '1px solid var(--border)',
      }}>
        {segments.map((seg, i) => (
          <div
            key={i}
            title={`${seg.label}: ${seg.count}${seg.agents.length > 0 ? ` (${seg.agents.join(', ')})` : ''}`}
            style={{
              width: `${(seg.count / totalAgents) * 100}%`,
              background: seg.color,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              minWidth: seg.count > 0 ? 24 : 0,
              transition: 'width 0.3s',
            }}
          >
            {seg.count > 0 && (
              <span style={{
                fontSize: 11,
                fontWeight: 600,
                color: seg.label === 'pending' ? 'var(--text-dim)' : '#000',
              }}>
                {seg.count}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
        {segments.map((seg, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: seg.color,
              border: seg.label === 'pending' ? '1px solid var(--border)' : 'none',
            }} />
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              {seg.label} ({seg.count})
            </span>
          </div>
        ))}
      </div>

      {/* Agent initials */}
      {votes.length > 0 && (
        <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
          {votes.map((v) => (
            <span
              key={v.id}
              title={`${v.agentId}: ${v.value}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                borderRadius: '50%',
                fontSize: 11,
                fontWeight: 600,
                background: `${voteColors[v.value] ?? 'var(--text-dim)'}33`,
                color: voteColors[v.value] ?? 'var(--text-dim)',
                border: `1px solid ${voteColors[v.value] ?? 'var(--border)'}`,
              }}
            >
              {v.agentId.slice(0, 2).toUpperCase()}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
