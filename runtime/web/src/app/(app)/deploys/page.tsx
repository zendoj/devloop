import StubPage from '@/components/stub-page';

export default function DeploysPage(): React.ReactElement {
  return (
    <StubPage
      title="Deploys"
      description="Pull-based deploy intent history and host apply status."
      phase="Fas 3"
      features={[
        'Signed desired_state_history rows (Ed25519 via signing_keys)',
        'Host apply lifecycle: started → heartbeat → success / failed / timed_out',
        'Late-success protection after timeout',
        'Deploy mutex visibility and rollback chains',
      ]}
    />
  );
}
