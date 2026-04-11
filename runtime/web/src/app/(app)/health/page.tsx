import { cookies } from 'next/headers';
import Link from 'next/link';
import { apiFetchServer } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface HealthProjectSummary {
  project_id: string;
  project_slug: string;
  last_status: string | null;
  last_probed_at: string | null;
  last_latency_ms: number | null;
  last_http_status: number | null;
  open_alert_id: string | null;
  open_alert_since: string | null;
  open_alert_worst: string | null;
  open_alert_ack: boolean;
  branch_protected: boolean | null;
  branch_compliance_pass: boolean | null;
  branch_last_checked_at: string | null;
  branch_failure_reason: string | null;
}

async function fetchHealth(): Promise<HealthProjectSummary[]> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const res = await apiFetchServer('/api/health', {
    method: 'GET',
    cookieHeader: cookieHeader.length > 0 ? cookieHeader : null,
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { items: HealthProjectSummary[] };
  return body.items;
}

function statusBadge(status: string | null): string {
  if (status === 'up') return 'status-ok';
  if (status === 'degraded') return 'status-warn';
  if (status === 'down') return 'status-bad';
  return 'status-pending';
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('sv-SE', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default async function HealthPage(): Promise<React.ReactElement> {
  const items = await fetchHealth();
  const up = items.filter((i) => i.last_status === 'up').length;
  const degraded = items.filter((i) => i.last_status === 'degraded').length;
  const down = items.filter((i) => i.last_status === 'down').length;
  const unknown = items.filter((i) => i.last_status === null).length;
  const openAlerts = items.filter((i) => i.open_alert_id).length;
  const unackAlerts = items.filter((i) => i.open_alert_id && !i.open_alert_ack).length;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Health</h1>
        <p className="page-sub">
          {items.length === 0
            ? 'No projects registered yet.'
            : `${items.length} project${items.length === 1 ? '' : 's'} · ${up} up · ${degraded} degraded · ${down} down · ${unknown} no probe · ${openAlerts} open alert${openAlerts === 1 ? '' : 's'} (${unackAlerts} unacked)`}
        </p>
      </div>

      {items.length === 0 ? (
        <div className="empty">
          <div className="empty-phase">Empty</div>
          <h2 className="empty-title">No projects</h2>
          <p className="empty-body">
            Register a project under <Link href="/projects">Projects</Link> to
            start seeing health probes here.
          </p>
        </div>
      ) : (
        <div className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Probe</th>
                <th>Latency</th>
                <th>HTTP</th>
                <th>Last probe</th>
                <th>Open alert</th>
                <th>Branch protection</th>
                <th>Last check</th>
              </tr>
            </thead>
            <tbody>
              {items.map((h) => (
                <tr key={h.project_id}>
                  <td>
                    <Link href={`/projects/${h.project_slug}`}>{h.project_slug}</Link>
                  </td>
                  <td>
                    <span className={`status-pill ${statusBadge(h.last_status)}`}>
                      {h.last_status ?? 'no data'}
                    </span>
                  </td>
                  <td style={{ fontSize: 12, color: '#6b7280' }}>
                    {h.last_latency_ms != null ? `${h.last_latency_ms}ms` : '—'}
                  </td>
                  <td style={{ fontSize: 12, color: '#6b7280' }}>
                    {h.last_http_status ?? '—'}
                  </td>
                  <td style={{ fontSize: 12, color: '#6b7280' }}>
                    {formatDate(h.last_probed_at)}
                  </td>
                  <td>
                    {h.open_alert_id ? (
                      <span
                        className={`status-pill ${h.open_alert_ack ? 'status-warn' : 'status-bad'}`}
                        title={`since ${formatDate(h.open_alert_since)} · worst=${h.open_alert_worst}`}
                      >
                        {h.open_alert_worst}
                        {!h.open_alert_ack && ' · unacked'}
                      </span>
                    ) : (
                      <span style={{ color: '#6b7280' }}>—</span>
                    )}
                  </td>
                  <td>
                    {h.branch_protected === null ? (
                      <span style={{ color: '#6b7280' }}>no data</span>
                    ) : h.branch_compliance_pass ? (
                      <span className="status-pill status-ok">protected · pass</span>
                    ) : (
                      <span
                        className="status-pill status-bad"
                        title={h.branch_failure_reason ?? ''}
                      >
                        {h.branch_protected ? 'non-compliant' : 'unprotected'}
                      </span>
                    )}
                  </td>
                  <td style={{ fontSize: 12, color: '#6b7280' }}>
                    {formatDate(h.branch_last_checked_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
