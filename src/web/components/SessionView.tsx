import { useState, useEffect } from 'preact/hooks';
import { MessageThread } from './MessageThread.js';
import { VoteBar } from './VoteBar.js';
import type { Session, Message, Vote, Decision } from '../../shared/types.js';

interface SessionData {
  session: Session;
  messages: Message[];
  votes: Vote[];
  decision: Decision | null;
}

interface Props {
  sessionId: string;
  refreshKey?: number;
  onBack: () => void;
}

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

export function SessionView({ sessionId, refreshKey, onBack }: Props) {
  const [data, setData] = useState<SessionData | null>(null);

  useEffect(() => {
    const load = async () => {
      const res = await fetch(`/api/sessions/${sessionId}`);
      if (res.ok) setData(await res.json());
    };
    load();
  }, [sessionId, refreshKey]);

  if (!data) {
    return <div style={{ color: 'var(--text-dim)', padding: 40 }}>Loading...</div>;
  }

  const { session, messages, votes, decision } = data;
  const amendments = messages.filter((m) => m.messageType === 'amendment');

  // Estimate total agents from unique voters + any additional known agents
  const uniqueVoters = new Set(votes.map((v) => v.agentId));
  const totalAgents = Math.max(uniqueVoters.size, votes.length > 0 ? uniqueVoters.size : 2);

  return (
    <div>
      <button
        onClick={onBack}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--accent)',
          cursor: 'pointer',
          fontSize: 14,
          marginBottom: 16,
          padding: 0,
        }}
      >
        &larr; Back to sessions
      </button>

      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: 20,
        marginBottom: 20,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>{session.title}</h2>
          <span style={{
            padding: '4px 12px',
            borderRadius: 12,
            fontSize: 13,
            fontWeight: 500,
            background: `${phaseColors[session.phase] ?? 'var(--text-dim)'}22`,
            color: phaseColors[session.phase] ?? 'var(--text-dim)',
          }}>
            {session.phase}
          </span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 8 }}>
          ID: {session.id} &middot; Round: {session.deliberationRound} &middot; Lead: {session.leadAgentId ?? 'none'}
        </div>
      </div>

      <div class="session-grid">
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Messages</h3>
          <MessageThread messages={messages} />
        </div>

        <div>
          {/* Vote Bar */}
          {votes.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Vote Distribution</h3>
              <VoteBar votes={votes} totalAgents={totalAgents} />
            </div>
          )}

          {/* Votes */}
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Votes</h3>
          {votes.length === 0 ? (
            <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>No votes yet</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
              {votes.map((v) => (
                <div key={v.id} style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  padding: 12,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontWeight: 500, fontSize: 13 }}>{v.agentId}</span>
                    <span style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: v.value === 'approve' ? 'var(--success)' : v.value === 'reject' ? 'var(--danger)' : 'var(--text-dim)',
                    }}>
                      {v.value.toUpperCase()}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{v.reasoning}</div>
                </div>
              ))}
            </div>
          )}

          {/* Decision */}
          {decision && (
            <div>
              <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Decision</h3>
              <div style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                padding: 12,
              }}>
                <div style={{
                  fontWeight: 600,
                  fontSize: 14,
                  color: decision.outcome === 'approved' ? 'var(--success)' : decision.outcome === 'rejected' ? 'var(--danger)' : 'var(--warning)',
                  marginBottom: 6,
                }}>
                  {decision.outcome.toUpperCase()}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{decision.summary}</div>
                {decision.humanNotes && (
                  <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 8, fontStyle: 'italic' }}>
                    Review notes: {decision.humanNotes}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Amendments */}
          {(session.phase === 'refinement' || amendments.length > 0) && (
            <div>
              <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>
                Amendments
                {session.phase === 'refinement' && (
                  <span style={{ fontSize: 12, color: '#f59e0b', marginLeft: 8 }}>
                    (refinement in progress)
                  </span>
                )}
              </h3>
              {amendments.length === 0 ? (
                <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>No amendments yet</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {amendments.map((a) => (
                    <div key={a.id} style={{
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderLeft: `3px solid ${
                        a.amendmentStatus === 'accepted' ? 'var(--success)'
                        : a.amendmentStatus === 'rejected' ? 'var(--danger)'
                        : '#f59e0b'
                      }`,
                      borderRadius: 'var(--radius)',
                      padding: 12,
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontWeight: 500, fontSize: 13 }}>{a.fromAgentId}</span>
                        <span style={{
                          fontSize: 11,
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          color: a.amendmentStatus === 'accepted' ? 'var(--success)'
                               : a.amendmentStatus === 'rejected' ? 'var(--danger)'
                               : '#f59e0b',
                        }}>
                          {a.amendmentStatus}
                        </span>
                      </div>
                      <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                        {a.content}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
