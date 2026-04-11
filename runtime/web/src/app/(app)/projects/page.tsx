import StubPage from '@/components/stub-page';

export default function ProjectsPage(): React.ReactElement {
  return (
    <StubPage
      title="Projects"
      description="Host projects DevLoop manages."
      phase="Fas 1b"
      features={[
        'List projects from the projects table',
        'Register a new host project (slug, repo, host_base_url)',
        'Rotate host and deploy tokens',
        'Per-project config activation (project_configs partial unique index)',
      ]}
    />
  );
}
