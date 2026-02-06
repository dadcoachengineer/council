import { useState } from 'preact/hooks';
import type { Decision } from '../../shared/types.js';

interface Props {
  decisions: Decision[];
  onReviewSubmitted: () => void;
}

export function DecisionReview({ decisions, onReviewSubmitted }: Props) {
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [reviewerName, setReviewerName] = useState('');

  const submitReview = async (sessionId: string, action: 'approve' | 'reject' | 'send_back') => {
    await fetch(`/api/sessions/${sessionId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        reviewedBy: reviewerName || 'Anonymous',
        notes: notes || undefined,
      }),
    });
    setReviewingId(null);
    setNotes('');
    onReviewSubmitted();
  };

  return (
    <div>
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20 }}>Pending Decisions</h2>

      {decisions.length === 0 ? (
        <p style={{ color: 'var(--text-dim)', padding: 40, textAlign: 'center' }}>
          No decisions pending review.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {decisions.map((d) => (
            <div key={d.id} style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: 20,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontWeight: 500 }}>Session: {d.sessionId.slice(0, 12)}...</span>
                <span style={{
                  fontWeight: 600,
                  fontSize: 13,
                  color: d.outcome === 'approved' ? 'var(--success)' : d.outcome === 'rejected' ? 'var(--danger)' : 'var(--warning)',
                }}>
                  Board voted: {d.outcome}
                </span>
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16 }}>{d.summary}</p>

              {reviewingId === d.sessionId ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <input
                    type="text"
                    placeholder="Your name"
                    value={reviewerName}
                    onInput={(e) => setReviewerName((e.target as HTMLInputElement).value)}
                    style={{
                      padding: '8px 12px',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius)',
                      color: 'var(--text)',
                      fontSize: 13,
                    }}
                  />
                  <textarea
                    placeholder="Review notes (optional)"
                    value={notes}
                    onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
                    rows={3}
                    style={{
                      padding: '8px 12px',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius)',
                      color: 'var(--text)',
                      fontSize: 13,
                      resize: 'vertical',
                      fontFamily: 'var(--font)',
                    }}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => submitReview(d.sessionId, 'approve')}
                      style={{
                        padding: '8px 16px', background: 'var(--success)', color: '#000',
                        border: 'none', borderRadius: 'var(--radius)', cursor: 'pointer', fontWeight: 500, fontSize: 13,
                      }}
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => submitReview(d.sessionId, 'reject')}
                      style={{
                        padding: '8px 16px', background: 'var(--danger)', color: '#fff',
                        border: 'none', borderRadius: 'var(--radius)', cursor: 'pointer', fontWeight: 500, fontSize: 13,
                      }}
                    >
                      Reject
                    </button>
                    <button
                      onClick={() => submitReview(d.sessionId, 'send_back')}
                      style={{
                        padding: '8px 16px', background: 'var(--warning)', color: '#000',
                        border: 'none', borderRadius: 'var(--radius)', cursor: 'pointer', fontWeight: 500, fontSize: 13,
                      }}
                    >
                      Send Back
                    </button>
                    <button
                      onClick={() => setReviewingId(null)}
                      style={{
                        padding: '8px 16px', background: 'var(--surface-2)', color: 'var(--text-dim)',
                        border: '1px solid var(--border)', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: 13,
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setReviewingId(d.sessionId)}
                  style={{
                    padding: '8px 16px', background: 'var(--accent)', color: '#fff',
                    border: 'none', borderRadius: 'var(--radius)', cursor: 'pointer', fontWeight: 500, fontSize: 13,
                  }}
                >
                  Review
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
