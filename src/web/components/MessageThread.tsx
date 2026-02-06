import type { Message } from '../../shared/types.js';

const typeColors: Record<string, string> = {
  discussion: 'var(--accent)',
  consultation: 'var(--info)',
  finding: 'var(--success)',
  proposal: 'var(--warning)',
};

interface Props {
  messages: Message[];
}

export function MessageThread({ messages }: Props) {
  if (messages.length === 0) {
    return <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>No messages yet</p>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {messages.map((msg) => (
        <div key={msg.id} style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: '12px 16px',
          borderLeft: `3px solid ${typeColors[msg.messageType] ?? 'var(--border)'}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{msg.fromAgentId}</span>
              {msg.toAgentId && (
                <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>&rarr; {msg.toAgentId}</span>
              )}
              <span style={{
                fontSize: 11,
                padding: '1px 6px',
                borderRadius: 6,
                background: `${typeColors[msg.messageType] ?? 'var(--text-dim)'}22`,
                color: typeColors[msg.messageType] ?? 'var(--text-dim)',
              }}>
                {msg.messageType}
              </span>
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              {new Date(msg.createdAt).toLocaleTimeString()}
            </span>
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
            {msg.content}
          </div>
        </div>
      ))}
    </div>
  );
}
