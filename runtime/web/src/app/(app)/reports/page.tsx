import { cookies } from 'next/headers';
import Link from 'next/link';
import { apiFetchServer } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface ReportListItem {
  id: string;
  project_slug: string;
  title: string;
  status: string;
  risk_tier: string | null;
  created_at: string;
  task_display_id: string | null;
}

async function fetchReports(): Promise<ReportListItem[]> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const res = await apiFetchServer('/api/reports', {
    method: 'GET',
    cookieHeader: cookieHeader.length > 0 ? cookieHeader : null,
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { items: ReportListItem[] };
  return body.items;
}

export default async function ReportsPage(): Promise<React.ReactElement> {
  const items = await fetchReports();

  return (
    <div className="page">
      <div className="page-header">
        <h1>Reports</h1>
        <p className="page-sub">
          {items.length === 0
            ? 'No reports filed yet.'
            : `${items.length} report${items.length === 1 ? '' : 's'}.`}
        </p>
      </div>

      <div className="page-actions">
        <Link href="/reports/new" className="btn btn-primary">
          + File a bug
        </Link>
      </div>

      {items.length === 0 ? (
        <div className="empty">
          <div className="empty-phase">Empty</div>
          <h2 className="empty-title">No reports yet</h2>
          <p className="empty-body">
            File your first bug report. It will create a paired task in the{' '}
            <Link href="/tasks">Tasks</Link> queue via the stub orchestrator.
            Actual Claude-based fix execution ships in a later phase.
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
                <th>Title</th>
                <th>Project</th>
                <th>Status</th>
                <th>Risk</th>
                <th>Task</th>
                <th>Filed</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="row-link">
                  <td>
                    <Link href={`/reports/${r.id}`} className="row-cell">
                      {r.title}
                    </Link>
                  </td>
                  <td className="mono">
                    <Link href={`/projects/${r.project_slug}`} className="row-cell">
                      {r.project_slug}
                    </Link>
                  </td>
                  <td>
                    <span className={`pill pill-${r.status}`}>{r.status}</span>
                  </td>
                  <td>
                    {r.risk_tier === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <span className="mono">{r.risk_tier}</span>
                    )}
                  </td>
                  <td className="mono">
                    {r.task_display_id === null ? (
                      <span className="muted">—</span>
                    ) : (
                      r.task_display_id
                    )}
                  </td>
                  <td className="muted mono">
                    {new Date(r.created_at).toLocaleString('sv-SE', {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    })}
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
