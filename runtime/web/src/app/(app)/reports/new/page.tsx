import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiFetchServer } from '@/lib/api';
import NewReportForm from './new-report-form';

export const dynamic = 'force-dynamic';

interface ProjectOption {
  id: string;
  slug: string;
  name: string;
}

async function fetchProjects(): Promise<ProjectOption[]> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const res = await apiFetchServer('/api/projects', {
    method: 'GET',
    cookieHeader: cookieHeader.length > 0 ? cookieHeader : null,
  });
  if (!res.ok) return [];
  const body = (await res.json()) as {
    items: Array<{ id: string; slug: string; name: string }>;
  };
  return body.items.map((p) => ({ id: p.id, slug: p.slug, name: p.name }));
}

export default async function NewReportPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}): Promise<React.ReactElement> {
  const projects = await fetchProjects();
  const sp = await searchParams;
  const preselectedSlug = sp.project;

  if (projects.length === 0) {
    redirect('/projects/new?reason=need-project-for-report');
  }

  const preselectedId =
    projects.find((p) => p.slug === preselectedSlug)?.id ?? projects[0]?.id ?? '';

  return (
    <div className="page">
      <div className="page-header">
        <h1>File a bug</h1>
        <p className="page-sub">
          Describe the bug. DevLoop opens a task from it. Actual fix
          execution ships in a later phase.
        </p>
      </div>
      <NewReportForm projects={projects} preselectedId={preselectedId} />
    </div>
  );
}
