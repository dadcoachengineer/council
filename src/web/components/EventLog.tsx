import type { IncomingEvent } from '../../shared/types.js';

interface Props {
  events: IncomingEvent[];
}

export function EventLog({ events }: Props) {
  return (
    <div>
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20 }}>Event Log</h2>

      {events.length === 0 ? (
        <p style={{ color: 'var(--text-dim)', padding: 40, textAlign: 'center' }}>
          No events received yet. Send a webhook to get started.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {events.map((event) => (
            <div key={event.id} style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '12px 16px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 6,
                    background: event.source === 'github' ? '#6e40c922' : 'var(--accent)22',
                    color: event.source === 'github' ? '#a78bfa' : 'var(--accent)',
                    fontWeight: 500,
                  }}>
                    {event.source}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{event.eventType}</span>
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                  {new Date(event.createdAt).toLocaleString()}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                {event.sessionId && <span>Session: {event.sessionId.slice(0, 12)}... &middot; </span>}
                ID: {event.id.slice(0, 12)}...
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
