import { useState } from 'preact/hooks';
import type { PublicUser } from '../../shared/types.js';

interface Props {
  onSetupComplete: (user: PublicUser) => void;
}

export function SetupPage({ onSetupComplete }: Props) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, displayName, password }),
      });

      if (res.ok) {
        const data = await res.json();
        onSetupComplete(data.user);
      } else {
        const data = await res.json();
        setError(data.error || 'Setup failed');
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
    fontFamily: 'var(--font)',
    outline: 'none',
    marginBottom: 12,
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
        width: 380,
      }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--accent)', marginBottom: 4 }}>
          Council Setup
        </h1>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 24 }}>
          Create your admin account to get started.
        </p>

        <label style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 4, display: 'block' }}>
          Display Name
        </label>
        <input
          type="text"
          value={displayName}
          onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)}
          placeholder="Your name"
          autoFocus
          required
          style={inputStyle}
        />

        <label style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 4, display: 'block' }}>
          Email
        </label>
        <input
          type="email"
          value={email}
          onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
          placeholder="admin@example.com"
          required
          style={inputStyle}
        />

        <label style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 4, display: 'block' }}>
          Password
        </label>
        <input
          type="password"
          value={password}
          onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          placeholder="Min 8 characters"
          required
          style={inputStyle}
        />

        <label style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 4, display: 'block' }}>
          Confirm Password
        </label>
        <input
          type="password"
          value={confirmPassword}
          onInput={(e) => setConfirmPassword((e.target as HTMLInputElement).value)}
          placeholder="Confirm password"
          required
          style={inputStyle}
        />

        {error && (
          <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !email || !displayName || !password || !confirmPassword}
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
            opacity: loading || !email || !displayName || !password ? 0.6 : 1,
          }}
        >
          {loading ? 'Creating account...' : 'Create Admin Account'}
        </button>
      </form>
    </div>
  );
}
