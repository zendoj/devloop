import StubPage from '@/components/stub-page';

export default function AuditPage(): React.ReactElement {
  return (
    <StubPage
      title="Audit"
      description="Append-only hash-chained audit log."
      phase="Fas 4"
      features={[
        'Full-text search across audit_events',
        'Chain integrity verification (SHA-256 link per row)',
        'Per-project, per-task, per-actor filters',
        'Export for compliance review',
      ]}
    />
  );
}
