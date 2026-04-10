/* eslint-disable no-console */
import 'reflect-metadata';
import * as argon2 from 'argon2';
import { DataSource } from 'typeorm';
import { buildDataSource } from '../src/data-source';

/**
 * Fas 0.9 smoke test. Bootstraps a test user, creates a session via
 * AuthService directly (no HTTP), verifies lookup, revokes, and
 * confirms the session is no longer valid.
 *
 * Run as:
 *   sudo -u devloop-admin DEVLOOP_DB_USER=devloop_owner \
 *     npx ts-node scripts/fas-0.9-smoke.ts
 *
 * We use devloop_owner here because the script both inserts a user
 * (needs owner) AND exercises the runtime queries that devloop_api
 * would run. This is fine for a local smoke test; production runtime
 * always uses devloop_api.
 */

const TEST_EMAIL = 'fas09-smoke@example.com';
const TEST_PASSWORD = 'correct horse battery staple';

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
  console.log('[smoke] Generating Argon2 hash for test user');
  const hash = await argon2.hash(TEST_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 4,
  });

  console.log('[smoke] Upserting test user');
  await ds.query(
    `
    INSERT INTO public.users (email, password_hash, role)
      VALUES ($1::citext, $2, 'admin'::public.user_role_enum)
      ON CONFLICT (email) DO UPDATE
        SET password_hash = EXCLUDED.password_hash,
            failed_login_count = 0,
            locked_until = NULL
    `,
    [TEST_EMAIL, hash],
  );

  console.log('[smoke] Importing auth services');
  // Dynamic imports so the services see the initialized DataSource via
  // the DI container layering we simulate below.
  const { PasswordService } = await import('../src/auth/services/password.service');
  const { SessionService } = await import('../src/auth/services/session.service');
  const { AuthService } = await import('../src/auth/services/auth.service');

  const { SecretsService } = await import('../src/config/secrets.service');
  const { TotpService } = await import('../src/auth/services/totp.service');
  const { DataEncryptionService } = await import('../src/auth/services/data-encryption.service');
  const { Challenge2faService } = await import('../src/auth/services/challenge-2fa.service');

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
  // Mimic Nest's lifecycle: onModuleInit precomputes the dummy hash.
  await auth.onModuleInit();

  // Ensure the test user is NOT 2FA-enrolled so login returns
  // { kind: 'session' } — this legacy smoke suite targets the
  // password-only path.
  await ds.query(
    `UPDATE public.users SET two_factor_enrolled = false, two_factor_secret = NULL WHERE email = $1::citext`,
    [TEST_EMAIL],
  );

  // --- Test 1: wrong password fails ---
  console.log('[smoke] TEST 1: bad password rejected');
  try {
    await auth.login(TEST_EMAIL, 'wrong-password-xxxx', '127.0.0.1', 'smoke');
    throw new Error('FAIL: bad password was accepted');
  } catch (err) {
    if ((err as { status?: number }).status === 401) {
      console.log('[smoke]   OK: 401 on bad password');
    } else {
      throw err;
    }
  }

  // --- Test 2: correct password returns a session ---
  console.log('[smoke] TEST 2: good password creates session');
  const outcome = await auth.login(TEST_EMAIL, TEST_PASSWORD, '127.0.0.1', 'smoke');
  if (outcome.kind !== 'session') {
    throw new Error(`FAIL: expected session, got ${outcome.kind}`);
  }
  const session = outcome.session;
  if (typeof session.token !== 'string' || session.token.length < 40) {
    throw new Error(`FAIL: bad token shape ${session.token}`);
  }
  console.log(`[smoke]   OK: session_id=${session.sessionId}`);

  // --- Test 3: lookup by token returns the session ---
  console.log('[smoke] TEST 3: lookupByToken succeeds');
  const ctx = await sessions.lookupByToken(session.token);
  if (!ctx || ctx.sessionId !== session.sessionId) {
    throw new Error('FAIL: lookup did not return matching session');
  }
  console.log(`[smoke]   OK: role=${ctx.role} expires=${ctx.expiresAt.toISOString()}`);

  // --- Test 4: tampered token fails ---
  console.log('[smoke] TEST 4: tampered token rejected');
  const tampered = session.token.slice(0, -3) + 'xxx';
  const bad = await sessions.lookupByToken(tampered);
  if (bad !== null) {
    throw new Error('FAIL: tampered token lookup returned a session');
  }
  console.log('[smoke]   OK: tampered token -> null');

  // --- Test 5: logout revokes the session ---
  console.log('[smoke] TEST 5: logout revokes session');
  await auth.logout(session.sessionId, ctx.userId);
  const after = await sessions.lookupByToken(session.token);
  if (after !== null) {
    throw new Error('FAIL: session still valid after logout');
  }
  console.log('[smoke]   OK: session invalidated');

  // --- Test 6: failed login increments failed_login_count and locks after 5 ---
  console.log('[smoke] TEST 6: lockout after 5 failed attempts');
  for (let i = 0; i < 5; i++) {
    try {
      await auth.login(TEST_EMAIL, 'wrong-password', '127.0.0.1', 'smoke');
    } catch {
      /* expected */
    }
  }
  const lockRows = (await ds.query(
    `SELECT failed_login_count, locked_until FROM public.users WHERE email = $1::citext`,
    [TEST_EMAIL],
  )) as Array<{ failed_login_count: number; locked_until: Date | null }>;
  const row = lockRows[0];
  if (!row || row.failed_login_count < 5 || !row.locked_until) {
    throw new Error(`FAIL: lockout not applied (row=${JSON.stringify(row)})`);
  }
  console.log(
    `[smoke]   OK: failed_login_count=${row.failed_login_count} locked_until=${row.locked_until.toString()}`,
  );

  // --- Test 7: login while locked returns 401 even with correct password ---
  console.log('[smoke] TEST 7: locked account rejects correct password');
  try {
    await auth.login(TEST_EMAIL, TEST_PASSWORD, '127.0.0.1', 'smoke');
    throw new Error('FAIL: locked account accepted correct password');
  } catch (err) {
    if ((err as { status?: number }).status === 401) {
      console.log('[smoke]   OK: 401 while locked');
    } else {
      throw err;
    }
  }

  // Unlock for teardown so re-running the smoke test is not blocked.
  await ds.query(
    `UPDATE public.users SET failed_login_count = 0, locked_until = NULL WHERE email = $1::citext`,
    [TEST_EMAIL],
  );

  // --- Test 8: token_hash in DB is SHA-256 of raw bytes, not the token ---
  console.log('[smoke] TEST 8: DB stores hash, not raw token');
  const outcome2 = await auth.login(TEST_EMAIL, TEST_PASSWORD, '127.0.0.1', 'smoke');
  if (outcome2.kind !== 'session') {
    throw new Error('FAIL: expected session');
  }
  const session2 = outcome2.session;
  const { createHash } = await import('node:crypto');
  const expectedHash = createHash('sha256')
    .update(Buffer.from(session2.token, 'base64url'))
    .digest();
  const stored = (await ds.query(
    `SELECT token_hash FROM public.sessions WHERE id = $1`,
    [session2.sessionId],
  )) as Array<{ token_hash: Buffer }>;
  const storedBytes = Buffer.isBuffer(stored[0]!.token_hash)
    ? stored[0]!.token_hash
    : Buffer.from(stored[0]!.token_hash);
  if (!storedBytes.equals(expectedHash)) {
    throw new Error('FAIL: stored token_hash does not match SHA-256 of raw token');
  }
  console.log('[smoke]   OK: token_hash matches');

  console.log('[smoke] ALL PASS');
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err);
  process.exit(1);
});
