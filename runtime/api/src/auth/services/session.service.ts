import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../db/db.module';

/**
 * Result of creating a new session. The `token` field is the raw cookie
 * value to return to the browser; it is NOT stored anywhere on the
 * server — only its SHA-256 hash is persisted, so a DB compromise does
 * not leak usable cookies.
 */
export interface NewSession {
  sessionId: string;
  token: string;
  expiresAt: Date;
}

/**
 * A looked-up active session, with the owner's id + role for downstream
 * authorization checks.
 */
export interface SessionContext {
  sessionId: string;
  userId: string;
  role: string;
  expiresAt: Date;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  // 24 hours. Per operator request: every session expires one day
  // after issue and requires a fresh password + 2FA to continue.
  // Short enough that a stolen cookie has a tight window, long
  // enough for a single working day.
  private readonly SESSION_TTL_MS = 24 * 60 * 60 * 1000;

  // Idle timeout equals the absolute TTL — there is no separate
  // idle window shorter than the TTL. Keeping this explicit so a
  // future change that lengthens SESSION_TTL_MS must decide what
  // to do about idle independently.
  private readonly IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  public async create(
    userId: string,
    ipAddr: string | null,
    userAgent: string | null,
  ): Promise<NewSession> {
    // 32 random bytes -> base64url (43 chars). This is the value that
    // goes into the cookie. We never store it server-side.
    const tokenBytes = randomBytes(32);
    const token = tokenBytes.toString('base64url');
    const tokenHash = createHash('sha256').update(tokenBytes).digest();

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.SESSION_TTL_MS);

    const rows = (await this.ds.query(
      `
      INSERT INTO public.sessions (
        user_id, token_hash, issued_at, expires_at, last_seen_at, ip_addr, user_agent
      ) VALUES ($1, $2, $3, $4, $3, $5, $6)
      RETURNING id
      `,
      [userId, tokenHash, now, expiresAt, ipAddr, userAgent],
    )) as Array<{ id: string }>;

    const sessionId = rows[0]?.id;
    if (!sessionId) {
      throw new Error('SessionService.create: INSERT did not return an id');
    }
    return { sessionId, token, expiresAt };
  }

  /**
   * Look up an active session by the raw cookie token. Hashes the
   * token, looks up the row by hash, validates expiration + idle
   * timeout, updates last_seen_at, and returns the SessionContext.
   *
   * Returns null on any failure: invalid token format, no matching
   * row, revoked, expired, idle-expired. Does not throw on bad input
   * so a random cookie string always 401s cleanly.
   */
  public async lookupByToken(token: string): Promise<SessionContext | null> {
    if (typeof token !== 'string' || token.length === 0) {
      return null;
    }

    let tokenBytes: Buffer;
    try {
      tokenBytes = Buffer.from(token, 'base64url');
    } catch {
      return null;
    }
    // 32 raw bytes. Reject anything else before hashing so we do not
    // waste a DB lookup on obviously bogus cookies.
    if (tokenBytes.length !== 32) {
      return null;
    }
    const tokenHash = createHash('sha256').update(tokenBytes).digest();

    const rows = (await this.ds.query(
      `
      SELECT s.id, s.user_id, s.expires_at, s.last_seen_at, s.token_hash, u.role::text AS role
        FROM public.sessions s
        JOIN public.users u ON u.id = s.user_id
       WHERE s.revoked_at IS NULL
         AND s.expires_at > now()
         AND s.token_hash = $1
      `,
      [tokenHash],
    )) as Array<{
      id: string;
      user_id: string;
      expires_at: Date;
      last_seen_at: Date;
      token_hash: Buffer;
      role: string;
    }>;

    const row = rows[0];
    if (!row) {
      return null;
    }

    // Constant-time comparison against the row's stored hash. The
    // indexed WHERE token_hash = $1 already selected this row, so the
    // compare is belt-and-suspenders against any future change that
    // might loosen the lookup query.
    const stored = Buffer.isBuffer(row.token_hash)
      ? row.token_hash
      : Buffer.from(row.token_hash);
    if (stored.length !== tokenHash.length || !timingSafeEqual(stored, tokenHash)) {
      return null;
    }

    const lastSeen = new Date(row.last_seen_at).getTime();
    if (Date.now() - lastSeen > this.IDLE_TIMEOUT_MS) {
      // Mark the session revoked on idle expiry so a subsequent probe
      // doesn't keep re-detecting the same idle row.
      await this.revoke(row.id);
      return null;
    }

    // Touch last_seen_at. We do not await this failing to revoke the
    // session; last_seen_at drift is non-security-critical.
    await this.ds
      .query(
        `UPDATE public.sessions SET last_seen_at = now() WHERE id = $1 AND revoked_at IS NULL`,
        [row.id],
      )
      .catch((err: unknown) => {
        this.logger.warn(`failed to touch last_seen_at for session ${row.id}: ${String(err)}`);
      });

    return {
      sessionId: row.id,
      userId: row.user_id,
      role: row.role,
      expiresAt: new Date(row.expires_at),
    };
  }

  public async revoke(sessionId: string): Promise<void> {
    await this.ds.query(
      `UPDATE public.sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId],
    );
  }
}
