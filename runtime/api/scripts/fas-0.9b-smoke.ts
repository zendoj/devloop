/* eslint-disable no-console */
import 'reflect-metadata';
import * as argon2 from 'argon2';
import { generate, generateSync } from 'otplib';
import { DataSource } from 'typeorm';
import { buildDataSource } from '../src/data-source';

/**
 * Fas 0.9b 2FA smoke test.
 *
 * Requires /etc/devloop/data_encryption_key (32 bytes) and
 * /etc/devloop/jwt_secret (>= 32 bytes) to be present so the
 * DataEncryptionService and Challenge2faService can initialize.
 *
 * Run as devloop-admin to seed/cleanup under devloop_owner role.
 */

const TEST_EMAIL = 'fas09b-2fa@example.com';
const TEST_PASSWORD = 'correct horse 2fa battery';

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
  console.log('[2fa-smoke] Importing services');
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

  console.log('[2fa-smoke] Upserting test user (not yet enrolled)');
  const pwHash = await argon2.hash(TEST_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 4,
  });
  await ds.query(
    `
    INSERT INTO public.users (email, password_hash, role)
      VALUES ($1::citext, $2, 'admin'::public.user_role_enum)
      ON CONFLICT (email) DO UPDATE
        SET password_hash = EXCLUDED.password_hash,
            two_factor_enrolled = false,
            two_factor_secret = NULL,
            failed_login_count = 0,
            locked_until = NULL
    `,
    [TEST_EMAIL, pwHash],
  );

  // --- TEST 1: DataEncryptionService round-trip ---
  console.log('[2fa-smoke] TEST 1: data encryption round-trip');
  const plaintext = 'JBSWY3DPEHPK3PXP';
  const enc = dataEnc.encrypt(plaintext);
  const dec = dataEnc.decrypt(enc);
  if (dec !== plaintext) {
    throw new Error(`FAIL: round-trip dec=${dec}`);
  }
  console.log('[2fa-smoke]   OK: round-trip');

  // --- TEST 2: tampered ciphertext fails GCM auth ---
  console.log('[2fa-smoke] TEST 2: tampered ciphertext rejected');
  const tampered = enc.slice(0, -4) + 'AAAA';
  try {
    dataEnc.decrypt(tampered);
    throw new Error('FAIL: tampered ciphertext decrypted');
  } catch (err) {
    if ((err as Error).message.includes('FAIL')) throw err;
    console.log('[2fa-smoke]   OK: tampered rejected');
  }

  // --- TEST 3: Challenge2faService round-trip ---
  console.log('[2fa-smoke] TEST 3: challenge token sign+verify');
  const uidRows = (await ds.query(
    `SELECT id FROM public.users WHERE email = $1::citext`,
    [TEST_EMAIL],
  )) as Array<{ id: string }>;
  const uid = uidRows[0]!.id;
  const signed = challenges.sign(uid);
  const verified = challenges.verify(signed);
  if (verified !== uid) {
    throw new Error(`FAIL: verify returned ${verified}, expected ${uid}`);
  }
  console.log('[2fa-smoke]   OK: challenge verified');

  // --- TEST 4: tampered challenge fails ---
  console.log('[2fa-smoke] TEST 4: tampered challenge rejected');
  const badChallenge = signed.slice(0, -3) + 'xxx';
  if (challenges.verify(badChallenge) !== null) {
    throw new Error('FAIL: tampered challenge verified');
  }
  console.log('[2fa-smoke]   OK: tampered rejected');

  // --- TEST 5: login without 2FA enrolled -> full session ---
  console.log('[2fa-smoke] TEST 5: login without 2FA yields full session');
  const outcome1 = await auth.login(TEST_EMAIL, TEST_PASSWORD, '127.0.0.1', 'smoke');
  if (outcome1.kind !== 'session') {
    throw new Error(`FAIL: expected session, got ${outcome1.kind}`);
  }
  console.log('[2fa-smoke]   OK: full session');

  // --- TEST 6: enroll 2FA ---
  console.log('[2fa-smoke] TEST 6: beginEnroll2fa');
  const enroll = await auth.beginEnroll2fa(uid);
  if (typeof enroll.secret !== 'string' || enroll.secret.length < 16) {
    throw new Error(`FAIL: bad secret ${enroll.secret}`);
  }
  if (!enroll.otpauthUri.startsWith('otpauth://totp/')) {
    throw new Error(`FAIL: bad URI ${enroll.otpauthUri}`);
  }
  console.log(`[2fa-smoke]   OK: secret=${enroll.secret} uri=${enroll.otpauthUri.slice(0, 60)}...`);

  // --- TEST 7: confirm 2FA with correct code ---
  console.log('[2fa-smoke] TEST 7: confirmEnroll2fa with correct code');
  let currentCode = generateSync({ secret: enroll.secret });
  try {
    await auth.confirmEnroll2fa(uid, currentCode);
  } catch (err) {
    // generateSync may not work without a sync-capable crypto plugin;
    // fall back to async generate if so.
    if (String(err).includes('sync')) {
      currentCode = await generate({ secret: enroll.secret });
      await auth.confirmEnroll2fa(uid, currentCode);
    } else {
      throw err;
    }
  }
  console.log('[2fa-smoke]   OK: enrolled');

  // --- TEST 8: login after enrollment -> pending_2fa ---
  console.log('[2fa-smoke] TEST 8: login after enrollment returns pending_2fa');
  const outcome2 = await auth.login(TEST_EMAIL, TEST_PASSWORD, '127.0.0.1', 'smoke');
  if (outcome2.kind !== 'pending_2fa') {
    throw new Error(`FAIL: expected pending_2fa, got ${outcome2.kind}`);
  }
  const challengeToken = outcome2.challenge;
  console.log('[2fa-smoke]   OK: pending_2fa challenge issued');

  // --- TEST 9: verify2fa with wrong code fails ---
  console.log('[2fa-smoke] TEST 9: verify2fa with bad code rejected');
  try {
    await auth.verify2fa(challengeToken, '000000', '127.0.0.1', 'smoke');
    throw new Error('FAIL: bad code accepted');
  } catch (err) {
    if ((err as { status?: number }).status === 401) {
      console.log('[2fa-smoke]   OK: 401 on bad code');
    } else {
      throw err;
    }
  }

  // --- TEST 10: verify2fa with correct code issues full session ---
  console.log('[2fa-smoke] TEST 10: verify2fa with correct code succeeds');
  const goodCode = await generate({ secret: enroll.secret });
  const session = await auth.verify2fa(challengeToken, goodCode, '127.0.0.1', 'smoke');
  if (typeof session.token !== 'string' || session.token.length < 40) {
    throw new Error('FAIL: bad session token');
  }
  console.log(`[2fa-smoke]   OK: session_id=${session.sessionId}`);

  // --- TEST 11: expired challenge is rejected ---
  console.log('[2fa-smoke] TEST 11: expired challenge rejected');
  // Sign a fresh token with TTL=0 by temporarily poking the private
  // field. Cleaner than replicating the HKDF derivation outside the
  // service just to craft a test token.
  const expiredToken = craftExpiredChallenge(challenges, uid);
  try {
    await auth.verify2fa(expiredToken, await generate({ secret: enroll.secret }), '127.0.0.1', 'smoke');
    throw new Error('FAIL: expired challenge accepted');
  } catch (err) {
    if ((err as { status?: number }).status === 401) {
      console.log('[2fa-smoke]   OK: 401 on expired');
    } else {
      throw err;
    }
  }

  // Cleanup
  await ds.query(
    `UPDATE public.users SET two_factor_enrolled = false, two_factor_secret = NULL WHERE email = $1::citext`,
    [TEST_EMAIL],
  );
  console.log('[2fa-smoke] ALL PASS');
}

/**
 * Reach into the private key field of a Challenge2faService instance
 * so the smoke test can forge an already-expired challenge without
 * duplicating the HKDF derivation logic. This is test-only code.
 */
function craftExpiredChallenge(svc: unknown, uid: string): string {
  const { createHmac } = require('node:crypto') as typeof import('node:crypto');
  const key = (svc as { key: Buffer }).key;
  const payload = { uid, iat: 0, exp: 1 };
  const json = JSON.stringify(payload);
  const mac = createHmac('sha256', key).update(json).digest('base64url');
  return Buffer.from(json, 'utf8').toString('base64url') + '.' + mac;
}

main().catch((err) => {
  console.error('[2fa-smoke] FAILED:', err);
  process.exit(1);
});
