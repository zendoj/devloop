import { cookies } from 'next/headers';
import Link from 'next/link';
import { apiFetchServer } from '@/lib/api';
import { QuickActionButtons } from './QuickActionButtons';

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

type FilterKey = 'all' | 'new' | 'working' | 'review' | 'ready_for_test' | 'done' | 'failed';

const FILTER_DEFS: Array<{ key: FilterKey; label: string; match: (status: string) => boolean }> = [
  { key: 'all', label: 'All', match: () => true },
  {
    key: 'new',
    label: 'New',
    match: (s) => s === 'queued_for_lock' || s === 'assigned',
  },
  {
    key: 'working',
    label: 'Working',
    match: (s) =>
      s === 'in_progress' ||
      s === 'approved' ||
      s === 'deploying' ||
      s === 'merged' ||
      s === 'verifying' ||
      s === 'rolling_back',
  },
  {
    key: 'review',
    label: 'AI review',
    match: (s) => s === 'review' || s === 'changes_requested',
  },
  {
    key: 'ready_for_test',
    label: 'Ready for test',
    match: (s) => s === 'ready_for_test',
  },
  {
    key: 'done',
    label: 'Done',
    match: (s) => s === 'accepted' || s === 'verified',
  },
  {
    key: 'failed',
    label: 'Failed / blocked',
    match: (s) =>
      s === 'failed' ||
      s === 'blocked' ||
      s === 'cancelled' ||
      s === 'rolled_back' ||
      s === 'rollback_failed',
  },
];

function parseFilter(raw: string | string[] | undefined): FilterKey {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value && FILTER_DEFS.some((f) => f.key === value)) {
    return value as FilterKey;
  }
  return 'all';
}

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}): Promise<React.ReactElement> {
  const sp = await searchParams;
  const activeKey = parseFilter(sp.status);
  const allItems = await fetchTasks();

  // Count per filter so the tab labels can show live counts.
  const counts: Record<FilterKey, number> = {
    all: allItems.length,
    new: 0,
    working: 0,
    review: 0,
    ready_for_test: 0,
    done: 0,
    failed: 0,
  };
  for (const item of allItems) {
    for (const f of FILTER_DEFS) {
      if (f.key !== 'all' && f.match(item.status)) counts[f.key] += 1;
    }
  }

  const active = FILTER_DEFS.find((f) => f.key === activeKey) ?? FILTER_DEFS[0]!;
  const items = allItems.filter((t) => active.match(t.status));

  return (
    <div className="page">
      <div className="page-header">
        <h1>Tasks</h1>
        <p className="page-sub">
          {allItems.length === 0
            ? 'No tasks in the queue yet.'
            : `${allItems.length} total · ${counts.ready_for_test} waiting on human test · ${counts.failed} failed`}
        </p>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 4,
          marginBottom: 16,
          flexWrap: 'wrap',
        }}
      >
        {FILTER_DEFS.map((f) => {
          const isActive = f.key === activeKey;
          const count = counts[f.key];
          const href = f.key === 'all' ? '/tasks' : `/tasks?status=${f.key}`;
          return (
            <Link
              key={f.key}
              href={href}
              style={{
                padding: '6px 12px',
                borderRadius: 4,
                fontSize: 12,
                fontWeight: isActive ? 600 : 400,
                textDecoration: 'none',
                color: isActive ? '#eaeaea' : '#8a8f99',
                background: isActive ? '#2a2f3a' : 'transparent',
                border: `1px solid ${isActive ? '#3a4050' : '#2a2f3a'}`,
              }}
            >
              {f.label}
              <span style={{ marginLeft: 6, color: '#6b7280' }}>{count}</span>
            </Link>
          );
        })}
      </div>

      {items.length === 0 ? (
        <div className="empty">
          <div className="empty-phase">Empty</div>
          <h2 className="empty-title">
            {activeKey === 'all' ? 'Nothing queued' : 'Nothing in this view'}
          </h2>
          <p className="empty-body">
            {activeKey === 'all' ? (
              <>
                Tasks are created automatically when a report is filed via the
                stub orchestrator. File a bug under{' '}
                <Link href="/reports">Reports</Link> to see a task appear here.
              </>
            ) : (
              <>
                No tasks match the <b>{active.label}</b> filter.{' '}
                <Link href="/tasks">Show all</Link>.
              </>
            )}
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
                <th>Module</th>
                <th>Risk</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id} className="row-link">
                  <td className="mono">
                    <Link href={`/tasks/${t.id}`} className="row-cell">
                      {t.display_id}
                    </Link>
                  </td>
                  <td>
                    <Link href={`/tasks/${t.id}`} className="row-cell">
                      {t.report_title}
                    </Link>
                  </td>
                  <td className="mono">
                    <Link href={`/projects/${t.project_slug}`} className="row-cell">
                      {t.project_slug}
                    </Link>
                  </td>
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
                  <td>
                    {t.status === 'ready_for_test' ? (
                      <QuickActionButtons taskId={t.id} />
                    ) : (
                      <span style={{ color: '#6b7280' }}>—</span>
                    )}
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
