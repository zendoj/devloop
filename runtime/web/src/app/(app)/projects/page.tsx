import { cookies } from 'next/headers';
import Link from 'next/link';
import { apiFetchServer } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface ProjectListItem {
  id: string;
  slug: string;
  name: string;
  status: string;
  host_base_url: string;
  github_owner: string;
  github_repo: string;
  github_default_branch: string;
  branch_protection_verified_at: string | null;
  created_at: string;
}

interface ProjectsResponse {
  items: ProjectListItem[];
  total: number;
}

async function fetchProjects(): Promise<ProjectsResponse> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const res = await apiFetchServer('/api/projects', {
    method: 'GET',
    cookieHeader: cookieHeader.length > 0 ? cookieHeader : null,
  });
  if (!res.ok) {
    return { items: [], total: 0 };
  }
  return (await res.json()) as ProjectsResponse;
}

export default async function ProjectsPage(): Promise<React.ReactElement> {
  const { items, total } = await fetchProjects();

  return (
    <div className="page">
      <div className="page-header">
        <h1>Projects</h1>
        <p className="page-sub">
          {total === 0
            ? 'No host projects registered yet.'
            : `${total} host project${total === 1 ? '' : 's'} under DevLoop management.`}
        </p>
      </div>

      <div className="page-actions">
        <Link href="/projects/new" className="btn btn-primary">
          + Register project
        </Link>
      </div>

      {items.length === 0 ? (
        <div className="empty">
          <div className="empty-phase">Empty</div>
          <h2 className="empty-title">No projects yet</h2>
          <p className="empty-body">
            Register your first host project to start pushing bug reports
            into DevLoop. You can also insert a row directly into{' '}
            <code>public.projects</code> via psql as{' '}
            <code>devloop_owner</code>.
          </p>
          <Link href="/projects/new" className="btn btn-primary">
            + Register project
          </Link>
        </div>
      ) : (
        <div className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Slug</th>
                <th>Name</th>
                <th>Status</th>
                <th>GitHub</th>
                <th>Branch</th>
                <th>Host</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id} className="row-link">
                  <td className="mono">
                    <Link href={`/projects/${p.slug}`} className="row-cell">
                      {p.slug}
                    </Link>
                  </td>
                  <td>
                    <Link href={`/projects/${p.slug}`} className="row-cell">
                      {p.name}
                    </Link>
                  </td>
                  <td>
                    <span className={`pill pill-${p.status}`}>{p.status}</span>
                  </td>
                  <td className="mono">
                    {p.github_owner}/{p.github_repo}
                  </td>
                  <td className="mono">{p.github_default_branch}</td>
                  <td className="mono truncate">{p.host_base_url}</td>
                  <td className="muted">
                    {new Date(p.created_at).toLocaleDateString('sv-SE')}
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
