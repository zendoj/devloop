import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { SessionContext, SessionService } from '../services/session.service';

const SESSION_COOKIE_NAME = 'devloop_session';

/**
 * Extended FastifyRequest shape so we can attach the session context
 * without monkey-patching `any`.
 */
interface RequestWithSession extends FastifyRequest {
  session?: SessionContext;
}

/**
 * SessionGuard — reads the devloop_session cookie, hashes it, looks up
 * the active session row, and attaches a SessionContext to the request.
 * Throws 401 on any failure.
 *
 * Note: Fastify cookie parsing requires @fastify/cookie registered on
 * the Fastify instance. That happens in main.ts; see registerCookiePlugin().
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  public async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithSession>();
    const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies;
    const token = cookies?.[SESSION_COOKIE_NAME];
    if (!token) {
      // Single generic 401 for any guard failure so response body
      // never distinguishes between "no cookie", "invalid cookie",
      // "expired session", or "revoked session".
      throw new UnauthorizedException('unauthorized');
    }

    const session = await this.sessions.lookupByToken(token);
    if (!session) {
      throw new UnauthorizedException('unauthorized');
    }

    req.session = session;
    return true;
  }
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE_NAME;
}
