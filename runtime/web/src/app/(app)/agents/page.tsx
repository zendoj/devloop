import { cookies } from 'next/headers';
import { apiFetchServer } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface AgentConfig {
  role: string;
  provider: string;
  model: string;
  api_key_ref: string;
  base_url_ref: string | null;
  system_prompt: string;
  max_budget_usd: string;
  timeout_ms: number;
  enabled: boolean;
  updated_at: string;
  updated_by: string;
}

async function fetchAgents(): Promise<AgentConfig[]> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const res = await apiFetchServer('/api/agents', {
    method: 'GET',
    cookieHeader: cookieHeader.length > 0 ? cookieHeader : null,
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { items: AgentConfig[] };
  return body.items;
}

function providerBadge(provider: string): string {
  switch (provider) {
    case 'webengine':
      return '◆ webengine';
    case 'openai':
      return '○ openai';
    case 'claude_cli':
      return '▢ claude CLI';
    case 'anthropic':
      return '◇ anthropic';
    default:
      return provider;
  }
}

export default async function AgentsPage(): Promise<React.ReactElement> {
  const items = await fetchAgents();

  return (
    <div className="page">
      <div className="page-header">
        <h1>Agents</h1>
        <p className="page-sub">
          {items.length === 0
            ? 'No agent_configs rows — run migration 021.'
            : `${items.length} agent role${items.length === 1 ? '' : 's'}. ${items.filter((i) => i.enabled).length} enabled, ${items.filter((i) => !i.enabled).length} disabled. (Read-only for now — edit via psql.)`}
        </p>
      </div>

      {items.length === 0 ? (
        <div className="empty">
          <div className="empty-phase">Empty</div>
          <h2 className="empty-title">No agents configured</h2>
        </div>
      ) : (
        <div className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Role</th>
                <th>Provider</th>
                <th>Model</th>
                <th>API key ref</th>
                <th>Base URL ref</th>
                <th>Budget</th>
                <th>Timeout</th>
                <th>Enabled</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.role} style={{ opacity: a.enabled ? 1 : 0.5 }}>
                  <td style={{ fontWeight: 600 }}>{a.role}</td>
                  <td>
                    <span className={`provider-badge provider-${a.provider}`}>
                      {providerBadge(a.provider)}
                    </span>
                  </td>
                  <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                    {a.model}
                  </td>
                  <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#6b7280' }}>
                    {a.api_key_ref}
                  </td>
                  <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#6b7280' }}>
                    {a.base_url_ref ?? '—'}
                  </td>
                  <td style={{ fontSize: 12 }}>${a.max_budget_usd}</td>
                  <td style={{ fontSize: 12, color: '#6b7280' }}>
                    {(a.timeout_ms / 1000).toFixed(0)}s
                  </td>
                  <td>
                    <span
                      className={`status-pill ${a.enabled ? 'status-ok' : 'status-pending'}`}
                    >
                      {a.enabled ? 'on' : 'off'}
                    </span>
                  </td>
                  <td style={{ fontSize: 12, color: '#6b7280' }}>
                    {new Date(a.updated_at).toLocaleString('sv-SE', {
                      year: 'numeric',
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          System prompts
        </h2>
        <div className="card" style={{ padding: 12 }}>
          {items.map((a) => (
            <div key={a.role} style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
                {a.role} <span style={{ color: '#6b7280', fontWeight: 400 }}>— {a.provider}:{a.model}</span>
              </div>
              <pre
                style={{
                  fontSize: 11,
                  color: '#c5c8d0',
                  background: '#0f1117',
                  padding: 8,
                  borderRadius: 4,
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {a.system_prompt || <em style={{ color: '#6b7280' }}>(empty)</em>}
              </pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
