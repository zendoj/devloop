import { cookies } from 'next/headers';
import Link from 'next/link';
import { apiFetchServer } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface DeployListItem {
  id: string;
  project_slug: string;
  project_id: string;
  seq_no: number;
  action: string;
  deploy_sha: string;
  base_sha: string;
  target_branch: string;
  signing_key_id: string;
  issued_at: string;
  applied_status: string | null;
  applied_at: string | null;
  applied_sha: string | null;
  issued_by_task_id: string | null;
  issued_by_display_id: string | null;
  task_status: string | null;
  task_title: string | null;
  task_module: string | null;
  github_pr_number: number | null;
}

async function fetchDeploys(): Promise<DeployListItem[]> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const res = await apiFetchServer('/api/deploys', {
    method: 'GET',
    cookieHeader: cookieHeader.length > 0 ? cookieHeader : null,
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { items: DeployListItem[] };
  return body.items;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusClass(status: string | null): string {
  switch (status) {
    case 'success':
      return 'status-ok';
    case 'failed':
    case 'timed_out':
      return 'status-bad';
    case null:
      return 'status-pending';
    default:
      return 'status-pending';
  }
}

function actionBadge(action: string): string {
  switch (action) {
    case 'deploy':
      return '▲ deploy';
    case 'rollback':
      return '↩ rollback';
    case 'baseline':
      return '◇ baseline';
    default:
      return action;
  }
}

export default async function DeploysPage(): Promise<React.ReactElement> {
  const items = await fetchDeploys();

  const totals = {
    total: items.length,
    success: items.filter((i) => i.applied_status === 'success').length,
    pending: items.filter((i) => i.applied_status === null).length,
    failed: items.filter(
      (i) => i.applied_status === 'failed' || i.applied_status === 'timed_out',
    ).length,
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Deploys</h1>
        <p className="page-sub">
          {items.length === 0
            ? 'No desired_state rows yet. Approved tasks flow through here after the deployer signs them.'
            : `${totals.total} rows · ${totals.success} success · ${totals.pending} pending · ${totals.failed} failed`}
        </p>
      </div>

      {items.length === 0 ? (
        <div className="empty">
          <div className="empty-phase">Empty</div>
          <h2 className="empty-title">No deploys yet</h2>
          <p className="empty-body">
            A deploy row is created when a task transitions from{' '}
            <code>approved</code> → <code>deploying</code>. The deployer signs
            an Ed25519 desired_state and writes it here; the host agent picks
            it up and reports back apply status.
          </p>
          <Link href="/tasks" className="btn btn-primary">
            View tasks
          </Link>
        </div>
      ) : (
        <div className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Seq</th>
                <th>Project</th>
                <th>Action</th>
                <th>Task</th>
                <th>Module</th>
                <th>Deploy SHA</th>
                <th>Target branch</th>
                <th>PR</th>
                <th>Apply status</th>
                <th>Issued</th>
                <th>Applied</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id}>
                  <td style={{ fontFamily: 'ui-monospace, monospace', color: '#6b7280' }}>
                    #{d.seq_no}
                  </td>
                  <td>
                    <Link href={`/projects/${d.project_slug}`}>{d.project_slug}</Link>
                  </td>
                  <td>
                    <span className={`action-badge action-${d.action}`}>
                      {actionBadge(d.action)}
                    </span>
                  </td>
                  <td>
                    {d.issued_by_display_id ? (
                      <Link href={`/tasks`}>{d.issued_by_display_id}</Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td style={{ color: '#6b7280' }}>{d.task_module ?? '—'}</td>
                  <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                    {d.deploy_sha.slice(0, 7)}
                  </td>
                  <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#6b7280' }}>
                    {d.target_branch}
                  </td>
                  <td>
                    {d.github_pr_number ? (
                      <span>#{d.github_pr_number}</span>
                    ) : (
                      <span style={{ color: '#6b7280' }}>—</span>
                    )}
                  </td>
                  <td>
                    <span className={`status-pill ${statusClass(d.applied_status)}`}>
                      {d.applied_status ?? 'pending'}
                    </span>
                  </td>
                  <td style={{ fontSize: 12, color: '#6b7280' }}>
                    {formatDate(d.issued_at)}
                  </td>
                  <td style={{ fontSize: 12, color: '#6b7280' }}>
                    {formatDate(d.applied_at)}
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
