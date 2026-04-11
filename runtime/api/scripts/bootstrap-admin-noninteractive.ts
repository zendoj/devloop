/* eslint-disable no-console */
import 'reflect-metadata';
import * as argon2 from 'argon2';
import * as qrcodeTerminal from 'qrcode-terminal';
import { DataSource } from 'typeorm';
import { buildDataSource } from '../src/data-source';

/**
 * Non-interactive variant of bootstrap-admin.ts. Takes email, role,
 * and password from environment variables and provisions a user in
 * a single shot:
 *
 *   BOOTSTRAP_EMAIL=admin@example.com
 *   BOOTSTRAP_ROLE=admin            # or super_admin
 *   BOOTSTRAP_PASSWORD=...          # min 12 chars
 *
 * Unlike the interactive script, this one marks the user as
 * two_factor_enrolled = TRUE immediately after writing the
 * encrypted secret. The caller is expected to capture the otpauth
 * URI + base32 secret printed to stdout and import them into an
 * authenticator app IMMEDIATELY — the secret is not stored anywhere
 * else in plaintext.
 *
 * The script is idempotent: re-running it with the same email
 * resets password + generates a fresh TOTP secret + re-enrolls.
 *
 * Run as:
 *   sudo -u devloop-admin env \
 *     DEVLOOP_DB_USER=devloop_owner \
 *     BOOTSTRAP_EMAIL=... BOOTSTRAP_ROLE=... BOOTSTRAP_PASSWORD=... \
 *     bash -c 'cd /opt/devloop/runtime/api && npx ts-node scripts/bootstrap-admin-noninteractive.ts'
 */

async function main(): Promise<void> {
  const email = process.env.BOOTSTRAP_EMAIL;
  const role = process.env.BOOTSTRAP_ROLE ?? 'admin';
  const password = process.env.BOOTSTRAP_PASSWORD;

  if (!email || !email.includes('@') || email.length < 5) {
    throw new Error('BOOTSTRAP_EMAIL must be a valid email address');
  }
  if (role !== 'admin' && role !== 'super_admin') {
    throw new Error(`BOOTSTRAP_ROLE must be admin or super_admin (got '${role}')`);
  }
  if (!password || password.length < 12) {
    throw new Error('BOOTSTRAP_PASSWORD must be at least 12 characters');
  }

  const ds = buildDataSource();
  await ds.initialize();
  try {
    await run(ds, email, role, password);
  } finally {
    await ds.destroy();
  }
}

async function run(
  ds: DataSource,
  email: string,
  role: string,
  password: string,
): Promise<void> {
  console.log('[bootstrap] Hashing password with Argon2id...');
  const hash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 4,
  });

  console.log(`[bootstrap] Upserting user ${email} as ${role}`);
  await ds.query(
    `
    INSERT INTO public.users (email, password_hash, role, two_factor_required, two_factor_enrolled)
      VALUES ($1::citext, $2, $3::public.user_role_enum, true, false)
      ON CONFLICT (email) DO UPDATE
        SET password_hash = EXCLUDED.password_hash,
            role = EXCLUDED.role,
            two_factor_required = true,
            two_factor_enrolled = false,
            two_factor_secret = NULL,
            failed_login_count = 0,
            locked_until = NULL
    `,
    [email, hash, role],
  );

  const { SecretsService } = await import('../src/config/secrets.service');
  const { DataEncryptionService } = await import('../src/auth/services/data-encryption.service');
  const { TotpService } = await import('../src/auth/services/totp.service');

  const secrets = new SecretsService();
  await secrets.onModuleInit();
  const dataEnc = new DataEncryptionService(secrets);
  dataEnc.onModuleInit();
  const totp = new TotpService();

  const secret = totp.generateSecret();
  const otpauthUri = totp.buildOtpauthUri(email, secret);
  const encrypted = dataEnc.encrypt(secret);

  await ds.query(
    `
    UPDATE public.users
       SET two_factor_secret   = $1,
           two_factor_enrolled = true
     WHERE email = $2::citext
    `,
    [encrypted, email],
  );

  // Emit the user_2fa_enabled audit event, best-effort (not fatal).
  try {
    await ds.query(
      `
      SELECT public.append_audit_event(
        NULL::uuid, NULL::uuid, NULL::uuid,
        'user_2fa_enabled'::public.audit_event_enum,
        'user'::public.actor_kind_enum,
        $1::varchar(128),
        jsonb_build_object('source', 'bootstrap-admin-noninteractive'),
        NULL::varchar(32), NULL::varchar(32), NULL::varchar(64), NULL::varchar(32)
      )
      `,
      [email],
    );
  } catch (err) {
    console.warn(`[bootstrap] warning: audit emission failed (${String(err)})`);
  }

  console.log('');
  console.log('=================================================================');
  console.log(`[bootstrap] ✓ Admin user ${email} provisioned and 2FA-enrolled.`);
  console.log('=================================================================');
  console.log('');
  console.log('Scan this QR in your authenticator app (Google Authenticator,');
  console.log('1Password, Authy, etc.):');
  console.log('');
  await new Promise<void>((resolve) => {
    qrcodeTerminal.generate(otpauthUri, { small: true }, (qr) => {
      console.log(qr);
      resolve();
    });
  });
  console.log('');
  console.log('Or enter the setup details manually if you have no scanner.');
  console.log('This is the ONLY time the secret is shown in plaintext:');
  console.log('');
  console.log(`  Base32 secret:  ${secret}`);
  console.log(`  Issuer:         DevLoop`);
  console.log(`  Account:        ${email}`);
  console.log('');
  console.log('  Full otpauth URI (for paste into any URI importer):');
  console.log(`    ${otpauthUri}`);
  console.log('');
  console.log('To log in:');
  console.log('  1. Open https://devloop.airpipe.ai');
  console.log(`  2. Email = ${email}`);
  console.log('  3. Enter your password');
  console.log('  4. Enter the 6-digit code from your authenticator');
  console.log('');
}

main().catch((err) => {
  console.error('[bootstrap] FAILED:', err);
  process.exit(1);
});
