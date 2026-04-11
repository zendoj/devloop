import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetchServer } from '@/lib/api';
import ThreadForm from './thread-form';

export const dynamic = 'force-dynamic';

interface ReportThread {
  id: string;
  author_kind: string;
  author_name: string;
  body: string;
  created_at: string;
}

interface ReportDetail {
  id: string;
  project_id: string;
  project_slug: string;
  title: string;
  description: string;
  corrected_description: string | null;
  status: string;
  risk_tier: string | null;
  created_at: string;
  triaged_at: string | null;
  resolved_at: string | null;
  task_display_id: string | null;
  threads: ReportThread[];
}

async function fetchReport(id: string): Promise<ReportDetail | null> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const res = await apiFetchServer(`/api/reports/${id}`, {
    method: 'GET',
    cookieHeader: cookieHeader.length > 0 ? cookieHeader : null,
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return (await res.json()) as ReportDetail;
}

export default async function ReportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const report = await fetchReport(id);
  if (!report) notFound();

  return (
    <div className="page">
      <div className="page-header">
        <h1>{report.title}</h1>
        <p className="page-sub">
          <Link href="/reports">← All reports</Link>
          {' · '}
          <Link href={`/projects/${report.project_slug}`}>
            {report.project_slug}
          </Link>
          {' · '}
          <span className={`pill pill-${report.status}`}>{report.status}</span>
          {report.task_display_id !== null && (
            <>
              {' · '}
              task{' '}
              <Link href="/tasks" className="mono">
                {report.task_display_id}
              </Link>
            </>
          )}
        </p>
      </div>

      <div className="detail-grid">
        <div>
          <section className="panel">
            <div className="panel-title-row">
              <h2 className="panel-title">Description</h2>
            </div>
            <div className="thread-entry-body">{report.description}</div>
          </section>

          {report.corrected_description !== null && (
            <section className="panel">
              <div className="panel-title-row">
                <h2 className="panel-title">Corrected description (classifier)</h2>
              </div>
              <div className="thread-entry-body">{report.corrected_description}</div>
            </section>
          )}

          <section className="panel">
            <div className="panel-title-row">
              <h2 className="panel-title">Thread ({report.threads.length})</h2>
            </div>
            {report.threads.length === 0 ? (
              <p className="panel-body" style={{ color: 'var(--fg-muted)' }}>
                No thread entries yet.
              </p>
            ) : (
              <div className="thread">
                {report.threads.map((t) => (
                  <div key={t.id} className="thread-entry">
                    <div className="thread-entry-head">
                      <span className="thread-entry-author">
                        {t.author_name}{' '}
                        <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}>
                          ({t.author_kind})
                        </span>
                      </span>
                      <span className="thread-entry-time">
                        {new Date(t.created_at).toLocaleString('sv-SE')}
                      </span>
                    </div>
                    <div className="thread-entry-body">{t.body}</div>
                  </div>
                ))}
              </div>
            )}
            <ThreadForm reportId={report.id} />
          </section>
        </div>

        <div>
          <section className="panel">
            <div className="panel-title-row">
              <h2 className="panel-title">Metadata</h2>
            </div>
            <dl className="kv-list">
              <dt>Report ID</dt>
              <dd className="mono">{report.id}</dd>
              <dt>Project</dt>
              <dd className="mono">{report.project_slug}</dd>
              <dt>Status</dt>
              <dd>{report.status}</dd>
              <dt>Risk</dt>
              <dd>{report.risk_tier ?? '—'}</dd>
              <dt>Created</dt>
              <dd className="mono">{new Date(report.created_at).toLocaleString('sv-SE')}</dd>
              <dt>Triaged</dt>
              <dd className="mono">
                {report.triaged_at === null
                  ? '—'
                  : new Date(report.triaged_at).toLocaleString('sv-SE')}
              </dd>
              <dt>Resolved</dt>
              <dd className="mono">
                {report.resolved_at === null
                  ? '—'
                  : new Date(report.resolved_at).toLocaleString('sv-SE')}
              </dd>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
