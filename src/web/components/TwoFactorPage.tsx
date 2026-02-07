import { useState } from 'preact/hooks';
import type { PublicUser } from '../../shared/types.js';

interface Props {
  pendingSession: string;
  onVerified: (user: PublicUser) => void;
  onBack: () => void;
}

export function TwoFactorPage({ pendingSession, onVerified, onBack }: Props) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const endpoint = useRecovery ? '/auth/login/recovery' : '/auth/login/2fa';

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingSession, code: code.trim() }),
      });

      const data = await res.json();

      if (res.ok) {
        onVerified(data.user);
      } else {
        setError(data.error || 'Verification failed');
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  const inputStyle = {
    width: '100%',
    padding: '10px 12px',
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--text)',
    fontSize: 14,
    fontFamily: 'var(--mono)',
    outline: 'none',
    marginBottom: 12,
    textAlign: 'center' as const,
    letterSpacing: '0.2em',
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      background: 'var(--bg)',
    }}>
      <form onSubmit={handleSubmit} style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: 32,
        width: 340,
      }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--accent)', marginBottom: 4 }}>
          Two-Factor Authentication
        </h1>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 24 }}>
          {useRecovery
            ? 'Enter one of your recovery codes.'
            : 'Enter the 6-digit code from your authenticator app.'
          }
        </p>

        <input
          type="text"
          value={code}
          onInput={(e) => setCode((e.target as HTMLInputElement).value)}
          placeholder={useRecovery ? 'xxxx-xxxx-xxxx' : '000000'}
          autoFocus
          required
          maxLength={useRecovery ? 20 : 6}
          style={inputStyle}
        />

        {error && (
          <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !code.trim()}
          style={{
            width: '100%',
            padding: '10px 16px',
            background: 'var(--accent)',
            color: 'white',
            border: 'none',
            borderRadius: 'var(--radius)',
            fontSize: 14,
            fontWeight: 500,
            cursor: loading ? 'wait' : 'pointer',
            opacity: loading || !code.trim() ? 0.6 : 1,
            marginBottom: 12,
          }}
        >
          {loading ? 'Verifying...' : 'Verify'}
        </button>

        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <button
            type="button"
            onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(''); }}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--accent)',
              cursor: 'pointer',
              fontSize: 13,
              padding: 0,
            }}
          >
            {useRecovery ? 'Use authenticator app' : 'Use a recovery code'}
          </button>
          <button
            type="button"
            onClick={onBack}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-dim)',
              cursor: 'pointer',
              fontSize: 13,
              padding: 0,
            }}
          >
            Back to login
          </button>
        </div>
      </form>
    </div>
  );
}
