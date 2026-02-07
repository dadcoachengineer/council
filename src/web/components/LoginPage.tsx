import { useState } from 'preact/hooks';

interface Props {
  onLogin: () => void;
}

export function LoginPage({ onLogin }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        onLogin();
      } else {
        const data = await res.json();
        setError(data.error || 'Login failed');
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
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
          Council
        </h1>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 24 }}>
          Enter password to continue
        </p>

        <input
          type="password"
          value={password}
          onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          placeholder="Password"
          autoFocus
          style={{
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
          }}
        />

        {error && (
          <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !password}
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
            opacity: loading || !password ? 0.6 : 1,
          }}
        >
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
