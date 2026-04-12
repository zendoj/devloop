import { cookies } from 'next/headers';
import { apiFetchServer } from '@/lib/api';
import { CreateUserForm } from './CreateUserForm';

export const dynamic = 'force-dynamic';

interface User {
  id: string;
  email: string;
  role: string;
  two_factor_enrolled: boolean;
  last_login_at: string | null;
  created_at: string;
}

async function fetchUsers(): Promise<User[] | null> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const res = await apiFetchServer('/auth/users', {
    method: 'GET',
    cookieHeader: cookieHeader.length > 0 ? cookieHeader : null,
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { users: User[] };
  return body.users;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default async function UsersPage(): Promise<React.ReactElement> {
  const users = await fetchUsers();

  if (!users) {
    return (
      <div className="page">
        <div className="page-header">
          <h1>Users</h1>
          <p className="page-sub">Admin access required.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Users</h1>
        <p className="page-sub">{users.length} user(s)</p>
      </div>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
          Add user
        </h2>
        <div className="card" style={{ padding: 14 }}>
          <CreateUserForm />
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
          Existing users
        </h2>
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 12,
            }}
          >
            <thead>
              <tr style={{ background: '#0f1117' }}>
                <th style={thStyle}>Email</th>
                <th style={thStyle}>Role</th>
                <th style={thStyle}>2FA</th>
                <th style={thStyle}>Last login</th>
                <th style={thStyle}>Created</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} style={{ borderTop: '1px solid #2a2f3a' }}>
                  <td style={tdStyle}>{u.email}</td>
                  <td style={tdStyle}>{u.role}</td>
                  <td style={tdStyle}>
                    {u.two_factor_enrolled ? (
                      <span style={{ color: '#6ee787' }}>enrolled</span>
                    ) : (
                      <span style={{ color: '#ff8080' }}>pending</span>
                    )}
                  </td>
                  <td style={tdStyle}>{formatDate(u.last_login_at)}</td>
                  <td style={tdStyle}>{formatDate(u.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 14px',
  fontSize: 11,
  fontWeight: 600,
  color: '#8a8f99',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

const tdStyle: React.CSSProperties = {
  padding: '10px 14px',
  color: '#c5c8d0',
};
