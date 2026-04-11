import { cookies } from 'next/headers';
import { apiFetchServer } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface SettingsPayload {
  signing_keys: Array<{
    key_id: string;
    algorithm: string;
    public_key_hex: string;
    status: string;
    created_at: string;
    retired_at: string | null;
  }>;
  sessions: Array<{
    id: string;
    user_id: string;
    username: string | null;
    created_at: string;
    last_seen_at: string | null;
    expires_at: string;
    ip: string | null;
    user_agent: string | null;
  }>;
  global_quota: Array<{
    period_key: string;
    metric: string;
    used_value: string;
    limit_value: string;
    updated_at: string;
  }>;
  project_quota: Array<{
    project_slug: string;
    period_key: string;
    metric: string;
    used_value: string;
    limit_value: string;
    updated_at: string;
  }>;
  secrets_status: Array<{
    name: string;
    present: boolean;
    bytes: number;
  }>;
}

async function fetchSettings(): Promise<SettingsPayload | null> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const res = await apiFetchServer('/api/settings', {
    method: 'GET',
    cookieHeader: cookieHeader.length > 0 ? cookieHeader : null,
  });
  if (!res.ok) return null;
  return (await res.json()) as SettingsPayload;
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

function truncate(s: string | null, n: number): string {
  if (!s) return '—';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export default async function SettingsPage(): Promise<React.ReactElement> {
  const data = await fetchSettings();

  if (!data) {
    return (
      <div className="page">
        <div className="page-header">
          <h1>Settings</h1>
          <p className="page-sub">Failed to load settings.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Settings</h1>
        <p className="page-sub">
          Runtime configuration · {data.signing_keys.length} signing key
          {data.signing_keys.length === 1 ? '' : 's'} · {data.sessions.length} active session
          {data.sessions.length === 1 ? '' : 's'} · {data.secrets_status.filter((s) => s.present).length}/{data.secrets_status.length} secrets present
        </p>
      </div>

      <section style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          Signing keys
        </h2>
        <div className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Key ID</th>
                <th>Algorithm</th>
                <th>Status</th>
                <th>Public key</th>
                <th>Created</th>
                <th>Retired</th>
              </tr>
            </thead>
            <tbody>
              {data.signing_keys.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ color: '#6b7280', padding: 14 }}>
                    No signing keys — run the bootstrap CLI to mint the first one.
                  </td>
                </tr>
              ) : (
                data.signing_keys.map((k) => (
                  <tr key={k.key_id}>
                    <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                      {k.key_id}
                    </td>
                    <td style={{ fontSize: 12 }}>{k.algorithm}</td>
                    <td>
                      <span
                        className={`status-pill ${k.status === 'active' ? 'status-ok' : 'status-pending'}`}
                      >
                        {k.status}
                      </span>
                    </td>
                    <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#6b7280' }}>
                      {k.public_key_hex.slice(0, 16)}…{k.public_key_hex.slice(-8)}
                    </td>
                    <td style={{ fontSize: 12, color: '#6b7280' }}>
                      {formatDate(k.created_at)}
                    </td>
                    <td style={{ fontSize: 12, color: '#6b7280' }}>
                      {formatDate(k.retired_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          Active sessions
        </h2>
        <div className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>User</th>
                <th>IP</th>
                <th>User agent</th>
                <th>Last seen</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              {data.sessions.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ color: '#6b7280', padding: 14 }}>
                    No active sessions.
                  </td>
                </tr>
              ) : (
                data.sessions.map((s) => (
                  <tr key={s.id}>
                    <td style={{ fontSize: 12 }}>{s.username ?? s.user_id.slice(0, 8)}</td>
                    <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#6b7280' }}>
                      {s.ip ?? '—'}
                    </td>
                    <td style={{ fontSize: 11, color: '#6b7280' }}>
                      {truncate(s.user_agent, 60)}
                    </td>
                    <td style={{ fontSize: 12, color: '#6b7280' }}>
                      {formatDate(s.last_seen_at)}
                    </td>
                    <td style={{ fontSize: 12, color: '#6b7280' }}>
                      {formatDate(s.expires_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          Secrets (file-backed)
        </h2>
        <div className="card" style={{ padding: 12 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {data.secrets_status.map((s) => (
              <div
                key={s.name}
                style={{
                  padding: '6px 10px',
                  background: s.present ? '#0f1117' : '#1a0a0a',
                  border: `1px solid ${s.present ? '#2a2f3a' : '#5a2a2a'}`,
                  borderRadius: 4,
                  fontSize: 12,
                }}
                title={s.present ? `${s.bytes} bytes` : 'missing'}
              >
                <code style={{ color: s.present ? '#6ee787' : '#ff8080' }}>
                  {s.present ? '✓' : '✗'}
                </code>{' '}
                <code>{s.name}</code>
                {s.present && (
                  <span style={{ color: '#6b7280', marginLeft: 6 }}>
                    {s.bytes}B
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          Global quotas
        </h2>
        <div className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Period</th>
                <th>Metric</th>
                <th>Used</th>
                <th>Limit</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.global_quota.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ color: '#6b7280', padding: 14 }}>
                    No global quota rows.
                  </td>
                </tr>
              ) : (
                data.global_quota.map((q) => (
                  <tr key={`${q.period_key}:${q.metric}`}>
                    <td style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>
                      {q.period_key}
                    </td>
                    <td style={{ fontSize: 12 }}>{q.metric}</td>
                    <td style={{ fontSize: 12 }}>{q.used_value}</td>
                    <td style={{ fontSize: 12, color: '#6b7280' }}>{q.limit_value}</td>
                    <td style={{ fontSize: 12, color: '#6b7280' }}>
                      {formatDate(q.updated_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          Per-project quotas
        </h2>
        <div className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Period</th>
                <th>Metric</th>
                <th>Used</th>
                <th>Limit</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.project_quota.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ color: '#6b7280', padding: 14 }}>
                    No per-project quota rows.
                  </td>
                </tr>
              ) : (
                data.project_quota.map((q) => (
                  <tr key={`${q.project_slug}:${q.period_key}:${q.metric}`}>
                    <td style={{ fontSize: 12 }}>{q.project_slug}</td>
                    <td style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>
                      {q.period_key}
                    </td>
                    <td style={{ fontSize: 12 }}>{q.metric}</td>
                    <td style={{ fontSize: 12 }}>{q.used_value}</td>
                    <td style={{ fontSize: 12, color: '#6b7280' }}>{q.limit_value}</td>
                    <td style={{ fontSize: 12, color: '#6b7280' }}>
                      {formatDate(q.updated_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
