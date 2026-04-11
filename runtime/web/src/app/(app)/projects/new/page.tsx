import NewProjectForm from './new-project-form';

export const dynamic = 'force-dynamic';

export default async function NewProjectPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}): Promise<React.ReactElement> {
  const sp = await searchParams;
  const needProjectForReport = sp.reason === 'need-project-for-report';

  return (
    <div className="page">
      <div className="page-header">
        <h1>Register project</h1>
        <p className="page-sub">
          Add a host project DevLoop should manage. The host and deploy
          tokens are shown once on the next screen — copy them now.
        </p>
      </div>
      {needProjectForReport && (
        <div className="form-error" style={{ marginBottom: 18 }}>
          You need to register a project before filing a report.
        </div>
      )}
      <NewProjectForm />
    </div>
  );
}
