import Link from 'next/link';

export default function OverviewPage(): React.ReactElement {
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
        <StatCard label="Projects" value="0" hint="Fas 1b" />
        <StatCard label="Open reports" value="0" hint="Fas 1c" />
        <StatCard label="Active tasks" value="0" hint="Fas 2" />
        <StatCard label="Deploys (7d)" value="0" hint="Fas 3" />
      </div>

      <section className="panel">
        <h2 className="panel-title">Getting started</h2>
        <ol className="steps">
          <li>
            <strong>Register a project.</strong> Add your first host project
            under <Link href="/projects">Projects</Link> (coming in Fas 1b).
          </li>
          <li>
            <strong>Install the deploy agent.</strong> The host runs a thin
            agent that polls for desired state. Docs arrive with Fas 3.
          </li>
          <li>
            <strong>Submit a report.</strong> Once a project is registered,
            reports flow into <Link href="/reports">Reports</Link>, get
            triaged into tasks, reviewed, and auto-deployed.
          </li>
        </ol>
      </section>

      <section className="panel">
        <h2 className="panel-title">Build status</h2>
        <p className="panel-body">
          The current build is <strong>Fas 1a — app shell</strong>. Each
          section in the sidebar shows the phase it ships in. See{' '}
          <code>/opt/devloop/docs/STATE.md</code> on the server for a detailed
          phase tracker.
        </p>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}): React.ReactElement {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-hint">{hint}</div>
    </div>
  );
}
