import StubPage from '@/components/stub-page';

export default function HealthPage(): React.ReactElement {
  return (
    <StubPage
      title="Health"
      description="Host health probes, open alerts, and compliance checks."
      phase="Fas 3"
      features={[
        'host_health probe history per project (up / degraded / down)',
        'One open alert per project with acknowledgement flow',
        'Branch protection compliance checks (5 min cache, every 6 hours)',
        'Transition escalation audit: degraded → down emits a second event',
      ]}
    />
  );
}
