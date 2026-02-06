import type { AgentStatus as AgentStatusType } from '../../shared/types.js';

interface Props {
  agents: AgentStatusType[];
}

export function AgentStatus({ agents }: Props) {
  return (
    <div>
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20 }}>Agents</h2>

      {agents.length === 0 ? (
        <p style={{ color: 'var(--text-dim)', padding: 40, textAlign: 'center' }}>
          No agents configured.
        </p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {agents.map((agent) => (
            <div key={agent.id} style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: 16,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 15 }}>{agent.name}</span>
                <span style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: agent.connected ? 'var(--success)' : 'var(--text-dim)',
                  display: 'inline-block',
                }} />
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 4 }}>{agent.role}</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                ID: {agent.id}
                {agent.lastSeen && (
                  <span> &middot; Last seen: {new Date(agent.lastSeen).toLocaleTimeString()}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
