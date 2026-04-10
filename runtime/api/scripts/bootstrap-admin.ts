/* eslint-disable no-console */
import 'reflect-metadata';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import * as argon2 from 'argon2';
import * as qrcodeTerminal from 'qrcode-terminal';
import { DataSource } from 'typeorm';
import { buildDataSource } from '../src/data-source';

/**
 * Bootstrap CLI — creates or resets an admin user with Argon2id
 * password hash, generates a TOTP secret, encrypts it with the
 * data_encryption_key via DataEncryptionService, prints a QR code
 * + otpauth URI to the terminal, asks for a verification TOTP code
 * to confirm the authenticator is set up correctly, and marks the
 * user as enrolled.
 *
 * Usage (must run as devloop-admin so peer auth maps to
 * devloop_owner, which has the INSERT/UPDATE rights on users):
 *
 *   sudo -u devloop-admin DEVLOOP_DB_USER=devloop_owner \
 *     npx ts-node scripts/bootstrap-admin.ts
 *
 * The script is interactive. It prompts for:
 *   - email
 *   - role (super_admin or admin; default admin)
 *   - password (read silently via readline with output suppressed)
 *   - password confirmation
 *
 * After provisioning it prints the TOTP secret + an ASCII QR so
 * Jonas can scan it into Google Authenticator / 1Password / etc.,
 * then asks for a current 6-digit code to confirm enrollment.
 *
 * A successful run emits a user_2fa_enabled audit event.
 */

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
  const rl = createInterface({ input, output });

  console.log('');
  console.log('=== DevLoop admin bootstrap ===');
  console.log('');

  const email = (await rl.question('Email: ')).trim();
  if (!email.includes('@') || email.length < 5) {
    throw new Error('bootstrap: email must be a valid address');
  }

  const roleRaw = (await rl.question('Role (admin | super_admin) [admin]: ')).trim();
  const role = roleRaw.length === 0 ? 'admin' : roleRaw;
  if (role !== 'admin' && role !== 'super_admin') {
    throw new Error(`bootstrap: role must be admin or super_admin (got '${role}')`);
  }

  const password = await askPasswordSilent(rl, 'Password (min 12 chars): ');
  if (password.length < 12) {
    throw new Error('bootstrap: password must be at least 12 characters');
  }
  const confirm = await askPasswordSilent(rl, 'Confirm password: ');
  if (password !== confirm) {
    throw new Error('bootstrap: passwords do not match');
  }

  console.log('');
  console.log('[bootstrap] Hashing password with Argon2id...');
  const hash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 4,
  });

  // Upsert user: same semantics as the smoke scripts. If the user
  // already exists, reset password + 2fa state and re-enroll.
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

  // Load services to generate + encrypt + verify the TOTP secret.
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
    `UPDATE public.users SET two_factor_secret = $1 WHERE email = $2::citext`,
    [encrypted, email],
  );

  // Any failure after the secret is stored in the DB must clear it
  // back out so we never leave a half-enrolled row behind. The single
  // "happy path commits the transaction" invariant lives in this
  // try/finally block.
  let committed = false;
  try {
    console.log('');
    console.log('Scan this QR with your authenticator app:');
    console.log('');
    await new Promise<void>((resolve) => {
      qrcodeTerminal.generate(otpauthUri, { small: true }, (qr) => {
        console.log(qr);
        resolve();
      });
    });
    console.log('Or enter the secret manually:');
    console.log(`  ${secret}`);
    console.log('');
    console.log('otpauth URI (for manual import):');
    console.log(`  ${otpauthUri}`);
    console.log('');

    // Verify the authenticator is set up by asking for a current code.
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = (
        await rl.question('Enter the 6-digit code from your authenticator to confirm: ')
      ).trim();
      if (!/^\d{6}$/.test(code)) {
        console.log('Code must be 6 digits. Try again.');
        continue;
      }
      const ok = await totp.verify(code, secret);
      if (ok) {
        // Flip the enrollment flag first (security-critical). Audit
        // emission is best-effort — a user who is enrolled but whose
        // audit-chain write hiccupped is NOT a broken account, so we
        // do not fail the whole bootstrap on audit failure.
        await ds.query(
          `UPDATE public.users SET two_factor_enrolled = true WHERE email = $1::citext`,
          [email],
        );
        committed = true;
        try {
          await emitAudit(ds, email);
        } catch (auditErr) {
          console.warn(
            `[bootstrap] warning: user_2fa_enabled audit emission failed (${String(auditErr)}). Account is still enrolled.`,
          );
        }
        console.log('');
        console.log(`[bootstrap] ✓ Admin user ${email} is provisioned and 2FA-enrolled.`);
        console.log('[bootstrap] You can now POST /auth/login + /auth/2fa/verify.');
        rl.close();
        return;
      }
      console.log(`Code rejected. ${2 - attempt} attempt(s) left.`);
    }

    // Fell through 3 attempts without a valid code.
    throw new Error('bootstrap: too many failed code attempts');
  } finally {
    if (!committed) {
      // Clear the stored secret on any failure path so the row is
      // never left half-enrolled. Swallow secondary errors here so
      // the primary error (which callers will see) is not masked.
      try {
        await ds.query(
          `UPDATE public.users SET two_factor_secret = NULL WHERE email = $1::citext`,
          [email],
        );
        console.log('[bootstrap] Cleared two_factor_secret (rollback).');
      } catch (cleanupErr) {
        console.error(
          `[bootstrap] CRITICAL: failed to clear two_factor_secret on rollback: ${String(cleanupErr)}`,
        );
      }
      rl.close();
    }
  }
}

async function emitAudit(ds: DataSource, email: string): Promise<void> {
  const rows = (await ds.query(
    `SELECT id FROM public.users WHERE email = $1::citext`,
    [email],
  )) as Array<{ id: string }>;
  const userId = rows[0]?.id;
  if (!userId) return;
  await ds.query(
    `
    SELECT public.append_audit_event(
      NULL::uuid, NULL::uuid, NULL::uuid,
      'user_2fa_enabled'::public.audit_event_enum,
      'user'::public.actor_kind_enum,
      $1::varchar(128),
      jsonb_build_object('source', 'bootstrap-admin'),
      NULL::varchar(32), NULL::varchar(32), NULL::varchar(64), NULL::varchar(32)
    )
    `,
    [email],
  );
}

/**
 * Ask for a password without echoing it to the terminal. Node's
 * readline does not mask input natively; we toggle raw mode on the
 * underlying tty so keystrokes do not render, and print backspaces
 * for each character the user types so the cursor stays put.
 */
async function askPasswordSilent(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
): Promise<string> {
  const tty = input as unknown as { isTTY?: boolean; setRawMode?: (raw: boolean) => void };
  if (tty.isTTY !== true) {
    // Non-interactive runs fall back to visible input.
    return rl.question(prompt);
  }
  output.write(prompt);
  tty.setRawMode?.(true);

  return new Promise<string>((resolve, reject) => {
    const chars: string[] = [];
    const onData = (buf: Buffer): void => {
      const s = buf.toString('utf8');
      for (const ch of s) {
        const code = ch.charCodeAt(0);
        if (code === 13 || code === 10) {
          cleanup();
          output.write('\n');
          resolve(chars.join(''));
          return;
        }
        if (code === 3) {
          cleanup();
          output.write('\n');
          reject(new Error('bootstrap: cancelled by Ctrl-C'));
          return;
        }
        if (code === 127 || code === 8) {
          if (chars.length > 0) chars.pop();
          continue;
        }
        chars.push(ch);
      }
    };
    const cleanup = (): void => {
      input.off('data', onData);
      tty.setRawMode?.(false);
    };
    input.on('data', onData);
  });
}

main().catch((err) => {
  console.error('[bootstrap] FAILED:', err);
  process.exit(1);
});
