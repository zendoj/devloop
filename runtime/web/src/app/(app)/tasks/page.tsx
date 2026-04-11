import StubPage from '@/components/stub-page';

export default function TasksPage(): React.ReactElement {
  return (
    <StubPage
      title="Tasks"
      description="Fix tasks flowing through the state machine."
      phase="Fas 2"
      features={[
        'Task board across the state machine (queued_for_lock → assigned → in_progress → review → approved → deploying → merged → verified)',
        'Module lock visualization (module_locks)',
        'Worker attribution (claimed_by, lease_until)',
        'Review decisions and changes_requested loops',
      ]}
    />
  );
}
