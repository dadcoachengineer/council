import { useState } from 'preact/hooks';
import type { PublicUser } from '../../shared/types.js';

interface Props {
  currentUser: PublicUser;
  onUserUpdated: (user: PublicUser) => void;
}

export function AccountSettings({ currentUser, onUserUpdated }: Props) {
  const [displayName, setDisplayName] = useState(currentUser.displayName);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  // 2FA state
  const [totpEnabled, setTotpEnabled] = useState(currentUser.totpEnabled);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [disablePassword, setDisablePassword] = useState('');
  const [regenPassword, setRegenPassword] = useState('');

  const updateProfile = async () => {
    setError('');
    setMessage('');
    const res = await fetch('/auth/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName }),
    });
    if (res.ok) {
      const data = await res.json();
      onUserUpdated(data.user);
      setMessage('Profile updated');
    } else {
      setError('Failed to update profile');
    }
  };

  const changePassword = async () => {
    setError('');
    setMessage('');
    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters');
      return;
    }
    const res = await fetch('/auth/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (res.ok) {
      setMessage('Password changed');
      setCurrentPassword('');
      setNewPassword('');
    } else {
      const data = await res.json();
      setError(data.error || 'Failed to change password');
    }
  };

  const enable2FA = async () => {
    setError('');
    const res = await fetch('/auth/2fa/enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      setQrDataUrl(data.qrDataUrl);
      setTotpSecret(data.secret);
    } else {
      const data = await res.json();
      setError(data.error || 'Failed to enable 2FA');
    }
  };

  const confirm2FA = async () => {
    setError('');
    const res = await fetch('/auth/2fa/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: totpCode }),
    });
    if (res.ok) {
      const data = await res.json();
      setTotpEnabled(true);
      setRecoveryCodes(data.recoveryCodes);
      setQrDataUrl('');
      setTotpSecret('');
      setTotpCode('');
      onUserUpdated({ ...currentUser, totpEnabled: true });
    } else {
      const data = await res.json();
      setError(data.error || 'Invalid code');
    }
  };

  const disable2FA = async () => {
    setError('');
    const res = await fetch('/auth/2fa/disable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: disablePassword }),
    });
    if (res.ok) {
      setTotpEnabled(false);
      setDisablePassword('');
      setRecoveryCodes([]);
      onUserUpdated({ ...currentUser, totpEnabled: false });
      setMessage('2FA disabled');
    } else {
      const data = await res.json();
      setError(data.error || 'Failed to disable 2FA');
    }
  };

  const regenerateCodes = async () => {
    setError('');
    const res = await fetch('/auth/2fa/recovery-codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: regenPassword }),
    });
    if (res.ok) {
      const data = await res.json();
      setRecoveryCodes(data.recoveryCodes);
      setRegenPassword('');
    } else {
      const data = await res.json();
      setError(data.error || 'Failed to regenerate codes');
    }
  };

  const inputStyle = {
    padding: '8px 12px',
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--text)',
    fontSize: 13,
    fontFamily: 'var(--font)',
    outline: 'none',
    width: '100%',
  };

  const sectionStyle = {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    padding: 20,
    marginBottom: 16,
  };

  return (
    <div>
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20 }}>Account Settings</h2>

      {message && <div style={{ color: 'var(--success)', fontSize: 13, marginBottom: 12 }}>{message}</div>}
      {error && <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}>{error}</div>}

      {/* Profile */}
      <div style={sectionStyle}>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Profile</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 12, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>Display Name</label>
            <input value={displayName} onInput={(e) => setDisplayName((e.target as HTMLInputElement).value)} style={inputStyle} />
          </div>
          <button onClick={updateProfile} style={{
            padding: '8px 16px', background: 'var(--accent)', color: '#fff',
            border: 'none', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: 13, fontWeight: 500,
          }}>
            Save
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 8 }}>
          Email: {currentUser.email} &middot; Role: {currentUser.role}
        </div>
      </div>

      {/* Change Password */}
      <div style={sectionStyle}>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Change Password</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input type="password" placeholder="Current password" value={currentPassword}
            onInput={(e) => setCurrentPassword((e.target as HTMLInputElement).value)} style={inputStyle} />
          <input type="password" placeholder="New password (min 8 chars)" value={newPassword}
            onInput={(e) => setNewPassword((e.target as HTMLInputElement).value)} style={inputStyle} />
          <button onClick={changePassword} disabled={!currentPassword || !newPassword} style={{
            padding: '8px 16px', background: 'var(--accent)', color: '#fff',
            border: 'none', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: 13, fontWeight: 500,
            opacity: !currentPassword || !newPassword ? 0.6 : 1, alignSelf: 'flex-start',
          }}>
            Change Password
          </button>
        </div>
      </div>

      {/* 2FA */}
      <div style={sectionStyle}>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Two-Factor Authentication</h3>

        {!totpEnabled && !qrDataUrl && (
          <button onClick={enable2FA} style={{
            padding: '8px 16px', background: 'var(--accent)', color: '#fff',
            border: 'none', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: 13, fontWeight: 500,
          }}>
            Enable 2FA
          </button>
        )}

        {qrDataUrl && (
          <div>
            <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 12 }}>
              Scan this QR code with your authenticator app, then enter the code to confirm.
            </p>
            <img src={qrDataUrl} alt="TOTP QR Code" style={{ width: 200, height: 200, marginBottom: 12, borderRadius: 'var(--radius)' }} />
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12, fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>
              Secret: {totpSecret}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="text" placeholder="6-digit code" value={totpCode} maxLength={6}
                onInput={(e) => setTotpCode((e.target as HTMLInputElement).value)}
                style={{ ...inputStyle, width: 140, textAlign: 'center', fontFamily: 'var(--mono)', letterSpacing: '0.2em' }} />
              <button onClick={confirm2FA} disabled={totpCode.length < 6} style={{
                padding: '8px 16px', background: 'var(--success)', color: '#000',
                border: 'none', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: 13, fontWeight: 500,
                opacity: totpCode.length < 6 ? 0.6 : 1,
              }}>
                Confirm
              </button>
            </div>
          </div>
        )}

        {totpEnabled && (
          <div>
            <p style={{ fontSize: 13, color: 'var(--success)', marginBottom: 12 }}>
              2FA is enabled.
            </p>

            {/* Recovery codes display */}
            {recoveryCodes.length > 0 && (
              <div style={{
                background: 'var(--surface-2)',
                borderRadius: 'var(--radius)',
                padding: 16,
                marginBottom: 16,
              }}>
                <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: 'var(--warning)' }}>
                  Save these recovery codes. They will not be shown again.
                </p>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 13, lineHeight: 2 }}>
                  {recoveryCodes.map((code, i) => (
                    <div key={i}>{code}</div>
                  ))}
                </div>
              </div>
            )}

            {/* Regenerate recovery codes */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>
                Regenerate recovery codes (requires password):
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="password" placeholder="Password" value={regenPassword}
                  onInput={(e) => setRegenPassword((e.target as HTMLInputElement).value)} style={{ ...inputStyle, width: 200 }} />
                <button onClick={regenerateCodes} disabled={!regenPassword} style={{
                  padding: '8px 16px', background: 'var(--surface-2)', color: 'var(--text)',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: 13,
                  opacity: !regenPassword ? 0.6 : 1,
                }}>
                  Regenerate
                </button>
              </div>
            </div>

            {/* Disable 2FA */}
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>
                Disable 2FA (requires password):
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="password" placeholder="Password" value={disablePassword}
                  onInput={(e) => setDisablePassword((e.target as HTMLInputElement).value)} style={{ ...inputStyle, width: 200 }} />
                <button onClick={disable2FA} disabled={!disablePassword} style={{
                  padding: '8px 16px', background: 'var(--danger)', color: '#fff',
                  border: 'none', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: 13,
                  opacity: !disablePassword ? 0.6 : 1,
                }}>
                  Disable 2FA
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
