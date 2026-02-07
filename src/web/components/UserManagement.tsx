import { useState, useEffect } from 'preact/hooks';
import type { PublicUser } from '../../shared/types.js';

interface Props {
  currentUser: PublicUser;
}

export function UserManagement({ currentUser }: Props) {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'member'>('member');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const fetchUsers = async () => {
    const res = await fetch('/api/admin/users');
    if (res.ok) setUsers(await res.json());
  };

  useEffect(() => { fetchUsers(); }, []);

  const createUser = async (e: Event) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail, displayName: newName, password: newPassword, role: newRole }),
      });
      if (res.ok) {
        setShowCreate(false);
        setNewEmail('');
        setNewName('');
        setNewPassword('');
        setNewRole('member');
        fetchUsers();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to create user');
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  const deleteUser = async (userId: string) => {
    if (!confirm('Are you sure you want to delete this user?')) return;
    await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
    fetchUsers();
  };

  const toggleRole = async (userId: string, currentRole: string) => {
    const newR = currentRole === 'admin' ? 'member' : 'admin';
    await fetch(`/api/admin/users/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newR }),
    });
    fetchUsers();
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
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600 }}>User Management</h2>
        <button
          onClick={() => setShowCreate(!showCreate)}
          style={{
            padding: '8px 16px',
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            borderRadius: 'var(--radius)',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          {showCreate ? 'Cancel' : 'Add User'}
        </button>
      </div>

      {showCreate && (
        <form onSubmit={createUser} style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: 20,
          marginBottom: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}>
          <input type="text" placeholder="Display name" value={newName} required
            onInput={(e) => setNewName((e.target as HTMLInputElement).value)} style={inputStyle} />
          <input type="email" placeholder="Email" value={newEmail} required
            onInput={(e) => setNewEmail((e.target as HTMLInputElement).value)} style={inputStyle} />
          <input type="password" placeholder="Temporary password (min 8 chars)" value={newPassword} required
            onInput={(e) => setNewPassword((e.target as HTMLInputElement).value)} style={inputStyle} />
          <select value={newRole} onChange={(e) => setNewRole((e.target as HTMLSelectElement).value as 'admin' | 'member')}
            style={{ ...inputStyle, appearance: 'auto' }}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          {error && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}
          <button type="submit" disabled={loading} style={{
            padding: '8px 16px', background: 'var(--accent)', color: '#fff',
            border: 'none', borderRadius: 'var(--radius)', cursor: 'pointer', fontWeight: 500, fontSize: 13,
            opacity: loading ? 0.6 : 1,
          }}>
            {loading ? 'Creating...' : 'Create User'}
          </button>
        </form>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {users.map((u) => (
          <div key={u.id} style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 18px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
          }}>
            <div>
              <div style={{ fontWeight: 500, marginBottom: 2 }}>{u.displayName}</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                {u.email} &middot; {new Date(u.createdAt).toLocaleDateString()}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {u.totpEnabled && (
                <span style={{ fontSize: 11, color: 'var(--success)', fontWeight: 500 }}>2FA</span>
              )}
              <button
                onClick={() => toggleRole(u.id, u.role)}
                style={{
                  padding: '3px 10px',
                  borderRadius: 12,
                  fontSize: 12,
                  fontWeight: 500,
                  border: '1px solid var(--border)',
                  background: u.role === 'admin' ? 'var(--accent)22' : 'var(--surface-2)',
                  color: u.role === 'admin' ? 'var(--accent)' : 'var(--text-dim)',
                  cursor: 'pointer',
                }}
              >
                {u.role}
              </button>
              {u.id !== currentUser.id && (
                <button
                  onClick={() => deleteUser(u.id)}
                  style={{
                    padding: '3px 10px',
                    borderRadius: 12,
                    fontSize: 12,
                    fontWeight: 500,
                    border: '1px solid var(--danger)33',
                    background: 'var(--danger)11',
                    color: 'var(--danger)',
                    cursor: 'pointer',
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
