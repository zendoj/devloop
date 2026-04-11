import { cookies } from 'next/headers';
import Link from 'next/link';
import { apiFetchServer } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface AuditEventListItem {
  id: number;
  project_slug: string | null;
  project_id: string | null;
  task_id: string | null;
  task_display_id: string | null;
  report_id: string | null;
  event_type: string;
  actor_kind: string;
  actor_name: string;
  from_status: string | null;
  to_status: string | null;
  commit_sha: string | null;
  review_decision: string | null;
  details: unknown;
  created_at: string;
  chain_prev_id: number;
}

async function fetchAudit(): Promise<AuditEventListItem[]> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const res = await apiFetchServer('/api/audit', {
    method: 'GET',
    cookieHeader: cookieHeader.length > 0 ? cookieHeader : null,
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { items: AuditEventListItem[] };
  return body.items;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function actorBadge(kind: string): string {
  switch (kind) {
    case 'user':
      return '◉';
    case 'agent':
      return '▣';
    case 'system':
      return '◇';
    default:
      return '·';
  }
}

export default async function AuditPage(): Promise<React.ReactElement> {
  const items = await fetchAudit();

  const byType = new Map<string, number>();
  for (const e of items) byType.set(e.event_type, (byType.get(e.event_type) ?? 0) + 1);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Audit</h1>
        <p className="page-sub">
          {items.length === 0
            ? 'Append-only hash-chained audit log — no events yet.'
            : `${items.length} most recent event${items.length === 1 ? '' : 's'} · hash-chained via chain_prev_id + SHA-256 chain_hash`}
        </p>
      </div>

      {items.length === 0 ? (
        <div className="empty">
          <div className="empty-phase">Empty</div>
          <h2 className="empty-title">No audit events</h2>
          <p className="empty-body">
            Every state transition, deploy, and reviewer decision
            appends a row to <code>audit_events</code>. File a report
            to generate some events.
          </p>
          <Link href="/reports/new" className="btn btn-primary">
            + File a bug
          </Link>
        </div>
      ) : (
        <div className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Event</th>
                <th>Actor</th>
                <th>Project</th>
                <th>Task</th>
                <th>Transition</th>
                <th>Commit</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#6b7280' }}>
                    #{e.id}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    <code>{e.event_type}</code>
                  </td>
                  <td style={{ fontSize: 12 }}>
                    <span style={{ color: '#6b7280', marginRight: 4 }}>
                      {actorBadge(e.actor_kind)}
                    </span>
                    {e.actor_name}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {e.project_slug ? (
                      <Link href={`/projects/${e.project_slug}`}>{e.project_slug}</Link>
                    ) : (
                      <span style={{ color: '#6b7280' }}>—</span>
                    )}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {e.task_display_id ? (
                      <Link href="/tasks">{e.task_display_id}</Link>
                    ) : (
                      <span style={{ color: '#6b7280' }}>—</span>
                    )}
                  </td>
                  <td style={{ fontSize: 11, color: '#6b7280' }}>
                    {e.from_status && e.to_status ? (
                      <span>
                        {e.from_status} → <strong style={{ color: '#c5c8d0' }}>{e.to_status}</strong>
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#6b7280' }}>
                    {e.commit_sha ? e.commit_sha.slice(0, 7) : '—'}
                  </td>
                  <td style={{ fontSize: 11, color: '#6b7280' }}>
                    {formatDate(e.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {byType.size > 0 && (
        <div style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
            By event type
          </h2>
          <div className="card" style={{ padding: 12 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {Array.from(byType.entries())
                .sort((a, b) => b[1] - a[1])
                .map(([type, n]) => (
                  <div
                    key={type}
                    style={{
                      padding: '4px 10px',
                      background: '#0f1117',
                      border: '1px solid #2a2f3a',
                      borderRadius: 4,
                      fontSize: 12,
                    }}
                  >
                    <code>{type}</code>{' '}
                    <span style={{ color: '#6b7280' }}>×{n}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
