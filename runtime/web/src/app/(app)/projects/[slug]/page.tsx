import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetchServer } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface ProjectDetail {
  id: string;
  slug: string;
  name: string;
  status: string;
  host_base_url: string;
  github_app_install_id: number;
  github_owner: string;
  github_repo: string;
  github_default_branch: string;
  host_token_id: string;
  deploy_token_id: string;
  deploy_allowlist_paths: string[];
  deploy_denied_paths: string[];
  branch_protection_required_checks: string[];
  branch_protection_verified_at: string | null;
  created_at: string;
  reports_open: number;
  tasks_open: number;
}

async function fetchProject(slug: string): Promise<ProjectDetail | null> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const res = await apiFetchServer(`/api/projects/${encodeURIComponent(slug)}`, {
    method: 'GET',
    cookieHeader: cookieHeader.length > 0 ? cookieHeader : null,
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return (await res.json()) as ProjectDetail;
}

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactElement> {
  const { slug } = await params;
  const project = await fetchProject(slug);
  if (!project) notFound();

  return (
    <div className="page">
      <div className="page-header">
        <h1>{project.name}</h1>
        <p className="page-sub">
          <Link href="/projects">← All projects</Link>
          {' · '}
          <span className="mono">{project.slug}</span>
          {' · '}
          <span className={`pill pill-${project.status}`}>
            {project.status}
          </span>
        </p>
      </div>

      <div className="page-actions">
        <Link
          href={`/reports/new?project=${encodeURIComponent(project.slug)}`}
          className="btn btn-primary"
        >
          + File a bug against this project
        </Link>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Open reports</div>
          <div className="stat-value">{project.reports_open}</div>
          <div className="stat-hint">not in terminal status</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Open tasks</div>
          <div className="stat-value">{project.tasks_open}</div>
          <div className="stat-hint">not verified / rolled_back / failed</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Host status</div>
          <div className="stat-value" style={{ fontSize: 20 }}>
            —
          </div>
          <div className="stat-hint">probe scanner in Fas 2</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Compliance</div>
          <div className="stat-value" style={{ fontSize: 20 }}>
            —
          </div>
          <div className="stat-hint">branch protection check in Fas 2</div>
        </div>
      </div>

      <div className="detail-grid">
        <div>
          <section className="panel">
            <div className="panel-title-row">
              <h2 className="panel-title">GitHub</h2>
            </div>
            <dl className="kv-list">
              <dt>Owner</dt>
              <dd className="mono">{project.github_owner}</dd>
              <dt>Repo</dt>
              <dd className="mono">{project.github_repo}</dd>
              <dt>Branch</dt>
              <dd className="mono">{project.github_default_branch}</dd>
              <dt>Install</dt>
              <dd className="mono">{project.github_app_install_id}</dd>
            </dl>
          </section>

          <section className="panel">
            <div className="panel-title-row">
              <h2 className="panel-title">Host</h2>
            </div>
            <dl className="kv-list">
              <dt>Base URL</dt>
              <dd className="mono">{project.host_base_url}</dd>
              <dt>Host token ID</dt>
              <dd className="mono">{project.host_token_id}</dd>
              <dt>Deploy token ID</dt>
              <dd className="mono">{project.deploy_token_id}</dd>
            </dl>
          </section>
        </div>

        <div>
          <section className="panel">
            <div className="panel-title-row">
              <h2 className="panel-title">Metadata</h2>
            </div>
            <dl className="kv-list">
              <dt>Project ID</dt>
              <dd className="mono">{project.id}</dd>
              <dt>Created</dt>
              <dd className="mono">
                {new Date(project.created_at).toLocaleString('sv-SE')}
              </dd>
              <dt>BP verified</dt>
              <dd className="mono">
                {project.branch_protection_verified_at === null
                  ? '—'
                  : new Date(project.branch_protection_verified_at).toLocaleString('sv-SE')}
              </dd>
            </dl>
          </section>

          <section className="panel">
            <div className="panel-title-row">
              <h2 className="panel-title">Branch protection checks</h2>
            </div>
            {project.branch_protection_required_checks.length === 0 ? (
              <p className="panel-body" style={{ color: 'var(--fg-muted)' }}>
                None configured.
              </p>
            ) : (
              <ul
                className="empty-list"
                style={{ color: 'var(--fg)', paddingLeft: 18 }}
              >
                {project.branch_protection_required_checks.map((c) => (
                  <li key={c} className="mono">
                    {c}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
