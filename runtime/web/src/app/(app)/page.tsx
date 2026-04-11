import { cookies } from 'next/headers';
import Link from 'next/link';
import { apiFetchServer } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface Stats {
  projects_total: number;
  reports_open: number;
  tasks_active: number;
  deploys_last_7d: number;
}

async function fetchStats(): Promise<Stats> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const res = await apiFetchServer('/api/overview/stats', {
    method: 'GET',
    cookieHeader: cookieHeader.length > 0 ? cookieHeader : null,
  });
  if (!res.ok) {
    return {
      projects_total: 0,
      reports_open: 0,
      tasks_active: 0,
      deploys_last_7d: 0,
    };
  }
  return (await res.json()) as Stats;
}

export default async function OverviewPage(): Promise<React.ReactElement> {
  const stats = await fetchStats();

  return (
    <div className="page">
      <div className="page-header">
        <h1>Overview</h1>
        <p className="page-sub">
          DevLoop central runtime — AI-assisted bug fixing across your host
          projects.
        </p>
      </div>

      <div className="stat-grid">
        <StatCard
          label="Projects"
          value={stats.projects_total.toString()}
          href="/projects"
        />
        <StatCard
          label="Open reports"
          value={stats.reports_open.toString()}
          href="/reports"
        />
        <StatCard
          label="Active tasks"
          value={stats.tasks_active.toString()}
          href="/tasks"
        />
        <StatCard
          label="Deploys (7d)"
          value={stats.deploys_last_7d.toString()}
          href="/deploys"
        />
      </div>

      <section className="panel">
        <h2 className="panel-title">Getting started</h2>
        <ol className="steps">
          <li>
            <strong>Register a project.</strong>{' '}
            <Link href="/projects/new">Add your first host project</Link>.
            You will get a host token and a deploy token to install on the
            host agent.
          </li>
          <li>
            <strong>File a bug report.</strong>{' '}
            <Link href="/reports/new">Open the report form</Link>, pick the
            project, describe the bug. DevLoop opens a task automatically
            via the stub orchestrator.
          </li>
          <li>
            <strong>Follow it.</strong> The task appears in{' '}
            <Link href="/tasks">Tasks</Link> in{' '}
            <code>queued_for_lock</code>. Actual Claude-based fix execution
            ships in a later phase — the rest of the pipeline (reviewer,
            deployer, host verification) is wired at the DB level.
          </li>
        </ol>
      </section>

      <section className="panel">
        <h2 className="panel-title">Build status</h2>
        <p className="panel-body">
          This build is <strong>Fas 1f</strong>. Sections in the sidebar
          mark the phase each screen ships in. Full phase tracker:{' '}
          <code>/opt/devloop/docs/STATE.md</code> on the server.
        </p>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href: string;
}): React.ReactElement {
  return (
    <Link href={href} className="stat-card stat-card-link">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </Link>
  );
}
