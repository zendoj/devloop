import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { LoginDto } from './dtos/login.dto';
import { Confirm2faDto, Verify2faDto } from './dtos/verify-2fa.dto';
import { getSessionCookieName, SessionGuard } from './guards/session.guard';
import { AuthService } from './services/auth.service';
import type { NewSession } from './services/session.service';
import type { SessionContext } from './services/session.service';

interface RequestWithSession extends FastifyRequest {
  session?: SessionContext;
}

const SESSION_COOKIE_NAME = getSessionCookieName();

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * POST /auth/login
   * Body: { email, password }
   * Returns:
   *   - 200 { status: "ok" } + Set-Cookie on full login
   *   - 200 { status: "pending_2fa", challenge } with NO cookie
   *   - 401 on any failure
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UsePipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }),
  )
  public async login(
    @Body() body: LoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<{ status: 'ok' } | { status: 'pending_2fa'; challenge: string }> {
    const outcome = await this.auth.login(
      body.email,
      body.password,
      extractClientIp(req),
      extractUserAgent(req),
    );
    if (outcome.kind === 'pending_2fa') {
      // No cookie issued on this step. Client sends the challenge back
      // with the TOTP code to /auth/2fa/verify.
      return { status: 'pending_2fa', challenge: outcome.challenge };
    }
    this.setSessionCookie(res, outcome.session);
    return { status: 'ok' };
  }

  /**
   * POST /auth/2fa/verify
   * Body: { challenge, code }
   * Consumes a pending-2FA challenge + TOTP code and issues a full
   * session cookie on success.
   */
  @Post('2fa/verify')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UsePipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }),
  )
  public async verify2fa(
    @Body() body: Verify2faDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<void> {
    const session = await this.auth.verify2fa(
      body.challenge,
      body.code,
      extractClientIp(req),
      extractUserAgent(req),
    );
    this.setSessionCookie(res, session);
  }

  /**
   * POST /auth/2fa/enroll
   * Authenticated. Generates + stores an encrypted TOTP secret for the
   * current user (leaving them un-enrolled), and returns the secret +
   * otpauth URI so the client can render a QR code.
   */
  @Post('2fa/enroll')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  public async enroll2fa(
    @Req() req: RequestWithSession,
  ): Promise<{ secret: string; otpauth_uri: string }> {
    const session = req.session;
    if (!session) {
      throw new UnauthorizedException('unauthorized');
    }
    const result = await this.auth.beginEnroll2fa(session.userId);
    return { secret: result.secret, otpauth_uri: result.otpauthUri };
  }

  /**
   * POST /auth/2fa/confirm
   * Body: { code }
   * Authenticated. Verifies the TOTP code against the in-progress
   * enrollment secret and flips two_factor_enrolled to true.
   */
  @Post('2fa/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SessionGuard)
  @UsePipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }),
  )
  public async confirm2fa(
    @Body() body: Confirm2faDto,
    @Req() req: RequestWithSession,
  ): Promise<void> {
    const session = req.session;
    if (!session) {
      throw new UnauthorizedException('unauthorized');
    }
    await this.auth.confirmEnroll2fa(session.userId, body.code);
  }

  private setSessionCookie(res: FastifyReply, session: NewSession): void {
    // Cookie hardening:
    //   httpOnly       — JS cannot read it
    //   secure         — only sent over HTTPS
    //   sameSite:lax   — sent on top-level navigations but not cross-site POSTs
    //   path:/         — valid for the whole API surface
    //   expires+maxAge — both set so every client stack picks up the TTL
    const ttlSeconds = Math.max(
      0,
      Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
    );
    res.setCookie(SESSION_COOKIE_NAME, session.token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      expires: session.expiresAt,
      maxAge: ttlSeconds,
    });
  }

  /**
   * POST /auth/logout
   * Requires a valid session. Revokes it server-side AND clears the cookie.
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SessionGuard)
  public async logout(
    @Req() req: RequestWithSession,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<void> {
    const session = req.session;
    if (!session) {
      // Guard populates req.session; missing here means a logic bug.
      throw new UnauthorizedException('unauthorized');
    }
    await this.auth.logout(session.sessionId, session.userId);
    // Mirror the set-cookie attributes so all client stacks clear the
    // value without falling back to "cookie with different attrs"
    // behavior. Matching path, secure, and sameSite exactly is cleaner.
    res.clearCookie(SESSION_COOKIE_NAME, {
      path: '/',
      secure: true,
      sameSite: 'lax',
    });
  }

  /**
   * POST /auth/me — minimal session introspection endpoint. Returns the
   * caller's user_id + role. Used by the frontend to gate UI, never as
   * an authoritative permission check (backend guards do that). POST
   * (not GET) so CSRF posture is uniform across auth routes.
   */
  @Post('me')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  public async me(@Req() req: RequestWithSession): Promise<{
    user_id: string;
    role: string;
    expires_at: string;
  }> {
    const session = req.session;
    if (!session) {
      throw new UnauthorizedException('unauthorized');
    }
    return {
      user_id: session.userId,
      role: session.role,
      expires_at: session.expiresAt.toISOString(),
    };
  }
}

function extractClientIp(req: FastifyRequest): string | null {
  // trustProxy is false in main.ts, so req.ip is the immediate peer,
  // which on this deployment is always 127.0.0.1 (Nginx reverse proxy).
  // We still record it for audit completeness.
  const ip = req.ip;
  return typeof ip === 'string' && ip.length > 0 ? ip : null;
}

function extractUserAgent(req: FastifyRequest): string | null {
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string' && ua.length > 0) {
    return ua.slice(0, 512);
  }
  return null;
}
