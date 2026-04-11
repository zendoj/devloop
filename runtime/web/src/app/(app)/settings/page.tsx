import StubPage from '@/components/stub-page';

export default function SettingsPage(): React.ReactElement {
  return (
    <StubPage
      title="Settings"
      description="User, organization, and runtime configuration."
      phase="Fas 5"
      features={[
        'User profile + 2FA re-enrollment',
        'Session management (list active sessions, revoke)',
        'Global and per-project quota configuration',
        'Signing key rotation helper (two-phase transactional)',
      ]}
    />
  );
}
