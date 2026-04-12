'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Inline "add user" form on the /users page. Admin-only (the
 * backend POST /auth/users enforces this; this component is
 * rendered inside a page the admin-gated layout already loads).
 *
 * New users get two_factor_required=true automatically — on
 * first login they are routed to /enroll-2fa.
 */

const ROLES = ['viewer', 'admin', 'super_admin'] as const;
type Role = (typeof ROLES)[number];

export function CreateUserForm(): React.ReactElement {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('admin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch('/auth/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          password,
          role,
        }),
      });
      if (!res.ok) {
        let msg = `Failed (${res.status})`;
        try {
          const body = (await res.json()) as { message?: string };
          if (body.message) msg = body.message;
        } catch {
          // ignore JSON parse failure — keep generic message
        }
        setError(msg);
        return;
      }
      const created = (await res.json()) as {
        id: string;
        email: string;
        role: string;
      };
      setSuccess(`Created ${created.email} (${created.role})`);
      setEmail('');
      setPassword('');
      setRole('admin');
      router.refresh();
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 140px auto',
          gap: 8,
          alignItems: 'end',
        }}
      >
        <label>
          <div style={labelStyle}>Email</div>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            maxLength={200}
            disabled={busy}
            style={inputStyle}
            autoComplete="off"
          />
        </label>
        <label>
          <div style={labelStyle}>Password (≥12 chars)</div>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={12}
            disabled={busy}
            style={inputStyle}
            autoComplete="new-password"
          />
        </label>
        <label>
          <div style={labelStyle}>Role</div>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            disabled={busy}
            style={inputStyle}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={busy || password.length < 12}
          style={{
            background: '#4f8cff',
            color: '#ffffff',
            border: 'none',
            borderRadius: 4,
            padding: '8px 16px',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            height: 34,
          }}
        >
          {busy ? 'Creating…' : 'Add user'}
        </button>
      </div>
      {error && (
        <div style={{ color: '#ff8080', fontSize: 11, marginTop: 8 }}>
          {error}
        </div>
      )}
      {success && (
        <div style={{ color: '#6ee787', fontSize: 11, marginTop: 8 }}>
          {success}
        </div>
      )}
    </form>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#8a8f99',
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '7px 10px',
  background: '#0f1117',
  color: '#ffffff',
  border: '1px solid #3a4050',
  borderRadius: 4,
  fontSize: 12,
  outline: 'none',
  boxSizing: 'border-box',
  height: 34,
};
