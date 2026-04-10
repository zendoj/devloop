/* eslint-disable no-console */
import 'reflect-metadata';
import * as argon2 from 'argon2';
import { DataSource } from 'typeorm';
import { buildDataSource } from '../src/data-source';

/**
 * Fas 0.9 RUNTIME smoke test — exercises the exact SQL paths the Nest
 * auth services run, but connects as devloop_api (the production role)
 * rather than devloop_owner. This catches missing column-level GRANTs
 * that the privileged smoke test misses.
 *
 * Pre-req: a user with id 7a9d24ce-c267-43dd-b6ab-85e7efd10c6b already
 * exists (seeded as devloop_owner). The runtime role only needs to
 * rewrite password_hash + failed_login_count + locked_until + last_login_at.
 *
 * Run as:
 *   sudo -u devloop-api DEVLOOP_DB_USER=devloop_api \
 *     npx ts-node scripts/fas-0.9-runtime-smoke.ts
 */

const TEST_EMAIL = 'fas09-runtime@example.com';
const TEST_PASSWORD = 'runtime-path-pwd-1234';

async function main(): Promise<void> {
  const ds = buildDataSource();
  await ds.initialize();
  try {
    await run(ds);
  } finally {
    await ds.destroy();
  }
}

async function run(ds: DataSource): Promise<void> {
  const { SecretsService } = await import('../src/config/secrets.service');
  const { PasswordService } = await import('../src/auth/services/password.service');
  const { SessionService } = await import('../src/auth/services/session.service');
  const { TotpService } = await import('../src/auth/services/totp.service');
  const { DataEncryptionService } = await import('../src/auth/services/data-encryption.service');
  const { Challenge2faService } = await import('../src/auth/services/challenge-2fa.service');
  const { AuthService } = await import('../src/auth/services/auth.service');

  const secrets = new SecretsService();
  await secrets.onModuleInit();
  const passwords = new PasswordService();
  const sessions = new SessionService(ds);
  const totp = new TotpService();
  const dataEnc = new DataEncryptionService(secrets);
  dataEnc.onModuleInit();
  const challenges = new Challenge2faService(secrets);
  challenges.onModuleInit();
  const auth = new AuthService(ds, passwords, sessions, totp, dataEnc, challenges);
  await auth.onModuleInit();

  // Legacy runtime-smoke targets the password-only path.
  await ds.query(
    `UPDATE public.users SET two_factor_enrolled = false, two_factor_secret = NULL WHERE email = $1::citext`,
    [TEST_EMAIL],
  );

  console.log('[runtime-smoke] Setting a valid Argon2 hash for the test user (via rehash path)');
  // The user was seeded with a placeholder hash that Argon2 cannot
  // parse. A failed login attempt is expected here — we then fix the
  // hash with a direct UPDATE using the runtime grant.
  const fresh = await argon2.hash(TEST_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 4,
  });
  await ds.query(
    `UPDATE public.users SET password_hash = $1, failed_login_count = 0, locked_until = NULL WHERE email = $2::citext`,
    [fresh, TEST_EMAIL],
  );

  console.log('[runtime-smoke] TEST A: login under devloop_api role');
  const outcome = await auth.login(TEST_EMAIL, TEST_PASSWORD, '127.0.0.1', 'runtime-smoke');
  if (outcome.kind !== 'session') {
    throw new Error(`FAIL: expected session, got ${outcome.kind}`);
  }
  const session = outcome.session;
  console.log(`[runtime-smoke]   OK: session_id=${session.sessionId}`);

  console.log('[runtime-smoke] TEST B: failed login increments counter under devloop_api');
  try {
    await auth.login(TEST_EMAIL, 'wrong-password-runtime', '127.0.0.1', 'runtime-smoke');
  } catch {
    /* expected */
  }
  const counterRow = (await ds.query(
    `SELECT failed_login_count FROM public.users WHERE email = $1::citext`,
    [TEST_EMAIL],
  )) as Array<{ failed_login_count: number }>;
  if (!counterRow[0] || counterRow[0].failed_login_count < 1) {
    throw new Error('FAIL: failed_login_count was not incremented under devloop_api');
  }
  console.log(`[runtime-smoke]   OK: failed_login_count=${counterRow[0].failed_login_count}`);

  console.log('[runtime-smoke] TEST C: logout under devloop_api');
  const ctx = await sessions.lookupByToken(session.token);
  if (!ctx) {
    throw new Error('FAIL: lookup returned null');
  }
  await auth.logout(session.sessionId, ctx.userId);
  const after = await sessions.lookupByToken(session.token);
  if (after !== null) {
    throw new Error('FAIL: session still valid after logout');
  }
  console.log('[runtime-smoke]   OK: logout works under devloop_api');

  // Reset for idempotency
  await ds.query(
    `UPDATE public.users SET failed_login_count = 0, locked_until = NULL WHERE email = $1::citext`,
    [TEST_EMAIL],
  );

  console.log('[runtime-smoke] ALL PASS');
}

main().catch((err) => {
  console.error('[runtime-smoke] FAILED:', err);
  process.exit(1);
});
