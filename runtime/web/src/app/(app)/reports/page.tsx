import StubPage from '@/components/stub-page';

export default function ReportsPage(): React.ReactElement {
  return (
    <StubPage
      title="Reports"
      description="Bug reports, feature asks, and incidents flowing into DevLoop."
      phase="Fas 1c"
      features={[
        'POST /reports intake (project_id, title, description)',
        'Report triage into agent_tasks rows via orchestrate_task_for_report',
        'Threaded comments (report_threads) and attachments (report_artifacts)',
        'Status machine: new → triaged → in_progress → resolved',
      ]}
    />
  );
}
