import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../db/db.module';
import { PasswordService } from './password.service';
import { NewSession, SessionService } from './session.service';

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
  ) {}

  public async onModuleInit(): Promise<void> {
    this.dummyHash = await this.passwords.hash('__no_such_user_dummy__');
  }

  public async login(
    email: string,
    password: string,
    ipAddr: string | null,
    userAgent: string | null,
  ): Promise<NewSession> {
    const normalizedEmail = typeof email === 'string' ? email.trim() : '';
    if (normalizedEmail.length === 0 || typeof password !== 'string' || password.length === 0) {
      throw new UnauthorizedException('invalid credentials');
    }

    const rows = (await this.ds.query(
      `
      SELECT id, password_hash, role::text AS role, failed_login_count, locked_until
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

    // Successful verify: clear lockout state, optionally re-hash.
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
      { session_id: session.sessionId, ip_addr: ipAddr },
    );

    return session;
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
