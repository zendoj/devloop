import { cookies } from 'next/headers';
import Link from 'next/link';
import { apiFetchServer } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface TaskListItem {
  id: string;
  display_id: string;
  project_slug: string;
  report_id: string;
  report_title: string;
  agent_name: string;
  module: string;
  risk_tier: string;
  status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

async function fetchTasks(): Promise<TaskListItem[]> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const res = await apiFetchServer('/api/tasks', {
    method: 'GET',
    cookieHeader: cookieHeader.length > 0 ? cookieHeader : null,
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { items: TaskListItem[] };
  return body.items;
}

export default async function TasksPage(): Promise<React.ReactElement> {
  const items = await fetchTasks();

  return (
    <div className="page">
      <div className="page-header">
        <h1>Tasks</h1>
        <p className="page-sub">
          {items.length === 0
            ? 'No tasks in the queue yet.'
            : `${items.length} task${items.length === 1 ? '' : 's'} across all projects.`}
        </p>
      </div>

      {items.length === 0 ? (
        <div className="empty">
          <div className="empty-phase">Empty</div>
          <h2 className="empty-title">Nothing queued</h2>
          <p className="empty-body">
            Tasks are created automatically when a report is filed via the
            stub orchestrator. File a bug under{' '}
            <Link href="/reports">Reports</Link> to see a task appear here.
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
                <th>Task</th>
                <th>Title</th>
                <th>Project</th>
                <th>Agent</th>
                <th>Module</th>
                <th>Risk</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id} className="row-link">
                  <td className="mono">
                    <Link href={`/reports/${t.report_id}`} className="row-cell">
                      {t.display_id}
                    </Link>
                  </td>
                  <td>
                    <Link href={`/reports/${t.report_id}`} className="row-cell">
                      {t.report_title}
                    </Link>
                  </td>
                  <td className="mono">
                    <Link href={`/projects/${t.project_slug}`} className="row-cell">
                      {t.project_slug}
                    </Link>
                  </td>
                  <td className="mono">{t.agent_name}</td>
                  <td className="mono">{t.module}</td>
                  <td className="mono">{t.risk_tier}</td>
                  <td>
                    <span className={`pill pill-${t.status.replace(/_/g, '-')}`}>
                      {t.status.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="muted mono">
                    {new Date(t.created_at).toLocaleString('sv-SE', {
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
