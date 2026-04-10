import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../db/db.module';
import { Challenge2faService } from './challenge-2fa.service';
import { DataEncryptionService } from './data-encryption.service';
import { PasswordService } from './password.service';
import { NewSession, SessionService } from './session.service';
import { TotpService } from './totp.service';

/**
 * Outcome of AuthService.login(). Either a full session is issued
 * immediately (no 2FA, or 2FA not yet enrolled — grace window for
 * initial enrollment) OR the password was correct but the user
 * has 2FA enrolled and must complete the TOTP challenge.
 */
export type LoginOutcome =
  | { kind: 'session'; session: NewSession }
  | { kind: 'pending_2fa'; challenge: string };

/**
 * LOGIN LOCKOUT POLICY (per ARCHITECTURE §5.1 "failed-login lockout"):
 *   - Every failed verify increments users.failed_login_count
 *   - At MAX_FAILED_ATTEMPTS consecutive failures the row is locked by
 *     setting users.locked_until = now() + LOCKOUT_WINDOW
 *   - A successful verify resets failed_login_count to 0 and clears
 *     locked_until
 *   - Any login attempt while locked_until > now() fails immediately
 *     with the same generic error as bad credentials, so attackers
 *     cannot enumerate locked accounts
 *
 * We use constant-time-like behavior by always hashing the provided
 * plaintext even when the user row does not exist, so response time
 * does not reveal which emails are registered.
 */
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  // A well-formed Argon2 hash of a throwaway value. We verify against
  // this when the user row does not exist so the failure path takes
  // the same amount of CPU work as the success path. Computed eagerly
  // in onModuleInit so the very first "no such user" attempt does NOT
  // observably do extra work compared to a later one.
  private dummyHash!: string;

  constructor(
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly totp: TotpService,
    private readonly dataEnc: DataEncryptionService,
    private readonly challenges: Challenge2faService,
  ) {}

  public async onModuleInit(): Promise<void> {
    this.dummyHash = await this.passwords.hash('__no_such_user_dummy__');
  }

  public async login(
    email: string,
    password: string,
    ipAddr: string | null,
    userAgent: string | null,
  ): Promise<LoginOutcome> {
    const normalizedEmail = typeof email === 'string' ? email.trim() : '';
    if (normalizedEmail.length === 0 || typeof password !== 'string' || password.length === 0) {
      throw new UnauthorizedException('invalid credentials');
    }

    const rows = (await this.ds.query(
      `
      SELECT id,
             password_hash,
             role::text AS role,
             failed_login_count,
             locked_until,
             two_factor_enrolled,
             two_factor_required
        FROM public.users
       WHERE email = $1::citext
       LIMIT 1
      `,
      [normalizedEmail],
    )) as Array<{
      id: string;
      password_hash: string;
      role: string;
      failed_login_count: number;
      locked_until: Date | null;
      two_factor_enrolled: boolean;
      two_factor_required: boolean;
    }>;

    const user = rows[0];

    if (!user) {
      await this.passwords.verify(this.dummyHash, password);
      await this.recordLoginFailure(null, normalizedEmail, ipAddr, 'no_such_user');
      throw new UnauthorizedException('invalid credentials');
    }

    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      // Still burn CPU on the hash so locked accounts cannot be
      // distinguished by response time.
      await this.passwords.verify(user.password_hash, password);
      await this.recordLoginFailure(user.id, normalizedEmail, ipAddr, 'account_locked');
      throw new UnauthorizedException('invalid credentials');
    }

    const ok = await this.passwords.verify(user.password_hash, password);
    if (!ok) {
      await this.incrementFailedCount(user.id);
      await this.recordLoginFailure(user.id, normalizedEmail, ipAddr, 'bad_password');
      throw new UnauthorizedException('invalid credentials');
    }

    // Successful password verify: clear lockout state. last_login_at is
    // NOT stamped here for 2FA-enrolled users — it is stamped only on
    // full-auth completion (either the non-2FA branch below or after
    // verify2fa). This preserves the semantic "last full login time".
    await this.ds.query(
      `
      UPDATE public.users
         SET failed_login_count = 0,
             locked_until = NULL
       WHERE id = $1
      `,
      [user.id],
    );

    if (this.passwords.needsRehash(user.password_hash)) {
      try {
        const fresh = await this.passwords.hash(password);
        await this.ds.query(
          `UPDATE public.users SET password_hash = $1 WHERE id = $2`,
          [fresh, user.id],
        );
      } catch (err) {
        this.logger.warn(`rehash failed for user ${user.id}: ${String(err)}`);
      }
    }

    // 2FA branch: password verified. If the user has 2FA enrolled,
    // stop here and return a short-lived challenge token. No session
    // cookie is issued yet — the client must present the challenge
    // token back with a valid TOTP code via verify2fa() below.
    //
    // If two_factor_required && !two_factor_enrolled, we grant a full
    // session anyway (grace window for first-time enrollment). The
    // frontend is expected to route such users into the enrollment
    // flow via /auth/me → must_enroll_2fa.
    if (user.two_factor_enrolled) {
      const challenge = this.challenges.sign(user.id);
      await this.safeEmitAudit(
        user.id,
        'user_login',
        'user',
        normalizedEmail,
        { stage: 'password_ok_pending_2fa', ip_addr: ipAddr },
      );
      return { kind: 'pending_2fa', challenge };
    }

    // Full-auth branch (no 2FA enrolled): stamp last_login_at and
    // issue the session.
    await this.ds.query(
      `UPDATE public.users SET last_login_at = now() WHERE id = $1`,
      [user.id],
    );
    const session = await this.sessions.create(user.id, ipAddr, userAgent);

    // Audit emission is non-fatal: a successful authentication has
    // already produced a valid session, and failing the response on an
    // audit-chain hiccup would leave the client holding a working
    // cookie it thinks did not work. We log and continue.
    await this.safeEmitAudit(
      user.id,
      'user_login',
      'user',
      normalizedEmail,
      {
        session_id: session.sessionId,
        ip_addr: ipAddr,
        two_factor_required: user.two_factor_required,
        two_factor_enrolled: user.two_factor_enrolled,
      },
    );

    return { kind: 'session', session };
  }

  /**
   * Exchange a challenge token + TOTP code for a full session. Called
   * after login() returns { kind: 'pending_2fa' }.
   */
  public async verify2fa(
    challengeToken: string,
    code: string,
    ipAddr: string | null,
    userAgent: string | null,
  ): Promise<NewSession> {
    if (typeof code !== 'string' || code.length === 0) {
      throw new UnauthorizedException('invalid 2fa');
    }
    const userId = this.challenges.verify(challengeToken);
    if (!userId) {
      throw new UnauthorizedException('invalid 2fa');
    }

    const rows = (await this.ds.query(
      `
      SELECT id, email::text AS email, two_factor_secret, two_factor_enrolled, locked_until
        FROM public.users
       WHERE id = $1
       LIMIT 1
      `,
      [userId],
    )) as Array<{
      id: string;
      email: string;
      two_factor_secret: string | null;
      two_factor_enrolled: boolean;
      locked_until: Date | null;
    }>;
    const user = rows[0];
    if (!user || !user.two_factor_enrolled || !user.two_factor_secret) {
      throw new UnauthorizedException('invalid 2fa');
    }
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      throw new UnauthorizedException('invalid 2fa');
    }

    let decryptedSecret: string;
    try {
      decryptedSecret = this.dataEnc.decrypt(user.two_factor_secret);
    } catch (err) {
      this.logger.error(`failed to decrypt 2FA secret for user ${user.id}: ${String(err)}`);
      throw new UnauthorizedException('invalid 2fa');
    }

    const ok = await this.totp.verify(code, decryptedSecret);
    if (!ok) {
      await this.incrementFailedCount(user.id);
      await this.safeEmitAudit(
        user.id,
        'user_2fa_failed',
        'user',
        user.email,
        { ip_addr: ipAddr },
      );
      throw new UnauthorizedException('invalid 2fa');
    }

    // Success: clear any counter the password step did not, stamp
    // last_login_at, issue a full session.
    await this.ds.query(
      `
      UPDATE public.users
         SET failed_login_count = 0,
             locked_until = NULL,
             last_login_at = now()
       WHERE id = $1
      `,
      [user.id],
    );
    const session = await this.sessions.create(user.id, ipAddr, userAgent);
    await this.safeEmitAudit(user.id, 'user_login', 'user', user.email, {
      session_id: session.sessionId,
      ip_addr: ipAddr,
      stage: '2fa_verified',
    });
    return session;
  }

  /**
   * Start 2FA enrollment for an authenticated user. Generates a fresh
   * secret, encrypts + stores it (leaving two_factor_enrolled=false),
   * and returns the base32 secret + otpauth URI for QR rendering.
   *
   * Calling this on a user that is already enrolled throws — the
   * caller must explicitly disable first (not implemented yet).
   */
  public async beginEnroll2fa(
    userId: string,
  ): Promise<{ secret: string; otpauthUri: string }> {
    const rows = (await this.ds.query(
      `SELECT email::text AS email, two_factor_enrolled FROM public.users WHERE id = $1`,
      [userId],
    )) as Array<{ email: string; two_factor_enrolled: boolean }>;
    const user = rows[0];
    if (!user) {
      throw new UnauthorizedException('no such user');
    }
    if (user.two_factor_enrolled) {
      throw new UnauthorizedException('already enrolled');
    }
    const secret = this.totp.generateSecret();
    const encrypted = this.dataEnc.encrypt(secret);
    await this.ds.query(
      `UPDATE public.users SET two_factor_secret = $1 WHERE id = $2`,
      [encrypted, userId],
    );
    const otpauthUri = this.totp.buildOtpauthUri(user.email, secret);
    return { secret, otpauthUri };
  }

  /**
   * Confirm 2FA enrollment by presenting a valid TOTP code against the
   * secret that was stored by beginEnroll2fa. Marks the user enrolled.
   */
  public async confirmEnroll2fa(userId: string, code: string): Promise<void> {
    if (typeof code !== 'string' || code.length === 0) {
      throw new UnauthorizedException('invalid 2fa');
    }
    const rows = (await this.ds.query(
      `SELECT email::text AS email, two_factor_secret, two_factor_enrolled FROM public.users WHERE id = $1`,
      [userId],
    )) as Array<{ email: string; two_factor_secret: string | null; two_factor_enrolled: boolean }>;
    const user = rows[0];
    if (!user || user.two_factor_enrolled || !user.two_factor_secret) {
      throw new UnauthorizedException('invalid 2fa');
    }
    let decryptedSecret: string;
    try {
      decryptedSecret = this.dataEnc.decrypt(user.two_factor_secret);
    } catch (err) {
      this.logger.error(`failed to decrypt 2FA secret for user ${userId}: ${String(err)}`);
      throw new UnauthorizedException('invalid 2fa');
    }
    if (!(await this.totp.verify(code, decryptedSecret))) {
      throw new UnauthorizedException('invalid 2fa');
    }
    await this.ds.query(
      `UPDATE public.users SET two_factor_enrolled = true WHERE id = $1`,
      [userId],
    );
    await this.safeEmitAudit(userId, 'user_2fa_enabled', 'user', user.email, {});
  }

  public async logout(sessionId: string, userId: string): Promise<void> {
    // Look up the email for audit fidelity. A concurrent user row
    // deletion (ON DELETE CASCADE from users) would already have
    // wiped the session, so a missing row here is handled gracefully.
    const emailRows = (await this.ds.query(
      `SELECT email::text AS email FROM public.users WHERE id = $1`,
      [userId],
    )) as Array<{ email: string }>;
    const email = emailRows[0]?.email ?? 'unknown';

    await this.sessions.revoke(sessionId);
    // Audit emission is non-fatal (see login): the session has
    // already been revoked, which is the security-critical part.
    await this.safeEmitAudit(userId, 'user_logout', 'user', email, {
      session_id: sessionId,
    });
  }

  private async incrementFailedCount(userId: string): Promise<void> {
    await this.ds.query(
      `
      UPDATE public.users
         SET failed_login_count = failed_login_count + 1,
             locked_until = CASE
               WHEN failed_login_count + 1 >= $2 THEN now() + ($3::text || ' milliseconds')::interval
               ELSE locked_until
             END
       WHERE id = $1
      `,
      [userId, MAX_FAILED_ATTEMPTS, String(LOCKOUT_WINDOW_MS)],
    );
  }

  private async recordLoginFailure(
    userId: string | null,
    email: string,
    ipAddr: string | null,
    reason: string,
  ): Promise<void> {
    await this.safeEmitAudit(
      userId,
      'user_login_failed',
      'user',
      email,
      { reason, ip_addr: ipAddr },
    );
  }

  /**
   * Audit emission wrapper that logs and swallows errors. Used for all
   * auth audits so the main flow (login/logout) is never coupled to
   * audit-chain availability.
   */
  private async safeEmitAudit(
    userId: string | null,
    eventType: string,
    actorKind: 'user' | 'system',
    actorName: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.emitAudit(userId, eventType, actorKind, actorName, details);
    } catch (err) {
      this.logger.warn(`failed to emit ${eventType} audit: ${String(err)}`);
    }
  }

  /**
   * append_audit_event signature (from migration 003) is:
   *   (p_project_id uuid, p_task_id uuid, p_report_id uuid,
   *    p_event_type audit_event_enum, p_actor_kind actor_kind_enum,
   *    p_actor_name varchar(128), p_details jsonb,
   *    p_from_status varchar(32), p_to_status varchar(32),
   *    p_commit_sha varchar(64), p_review_decision varchar(32))
   *
   * For auth events project/task/report are all NULL.
   */
  private async emitAudit(
    userId: string | null,
    eventType: string,
    actorKind: 'user' | 'system',
    actorName: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const payload = {
      ...details,
      user_id: userId,
    };
    await this.ds.query(
      `
      SELECT public.append_audit_event(
        NULL::uuid, NULL::uuid, NULL::uuid,
        $1::public.audit_event_enum,
        $2::public.actor_kind_enum,
        $3::varchar(128),
        $4::jsonb,
        NULL::varchar(32), NULL::varchar(32), NULL::varchar(64), NULL::varchar(32)
      )
      `,
      [eventType, actorKind, actorName, JSON.stringify(payload)],
    );
  }
}
