import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { FastifyRequest } from 'fastify';
import { DataSource } from 'typeorm';
import { Inject } from '@nestjs/common';
import { DATA_SOURCE } from '../db/db.module';
import { SecretsService } from '../config/secrets.service';

/**
 * HostAuthGuard — validates `Authorization: Host <id>.<secret>`
 * against the projects table. The token shape is identical to
 * what ProjectsService.mintToken() hands out on project
 * registration: 32 hex chars of id, a dot, 48 hex chars of
 * secret. The plaintext id is the row lookup key; the secret
 * is HMAC-SHA256'd with the jwt_secret (same derivation as at
 * mint time) and compared timing-safe against the stored
 * host_token_hmac bytea.
 *
 * On success the request gets a `host` context containing the
 * project id + slug + row id. On any failure: generic 401
 * 'unauthorized' with no info leak.
 *
 * NOTE: This guard is intended for the Fas 5 host report relay
 * path only. It does NOT set the same request.session shape
 * as SessionGuard — downstream handlers must read req.host
 * instead.
 */

export interface HostContext {
  project_id: string;
  project_slug: string;
}

interface RequestWithHost extends FastifyRequest {
  devloopHost?: HostContext;
}

@Injectable()
export class HostAuthGuard implements CanActivate {
  constructor(
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    private readonly secrets: SecretsService,
  ) {}

  public async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithHost>();
    const authHeader = req.headers['authorization'];
    if (typeof authHeader !== 'string' || authHeader.length === 0) {
      throw new UnauthorizedException('unauthorized');
    }

    const prefix = 'Host ';
    if (!authHeader.startsWith(prefix)) {
      throw new UnauthorizedException('unauthorized');
    }
    const raw = authHeader.slice(prefix.length).trim();

    // Token shape: 32 hex '.' 48 hex.
    if (!/^[0-9a-f]{32}\.[0-9a-f]{48}$/.test(raw)) {
      throw new UnauthorizedException('unauthorized');
    }
    const dotIdx = raw.indexOf('.');
    const tokenId = raw.slice(0, dotIdx);

    // Compute the expected HMAC the same way ProjectsService.mintToken did.
    const key = this.secrets.getSecret('jwt_secret');
    const expectedHmac = createHmac('sha256', key).update(raw).digest();

    // Lookup by host_token_id (unique indexed column) so we only
    // load one row, then constant-time compare the HMAC.
    const rows = (await this.ds.query(
      `
      SELECT id, slug, host_token_hmac
        FROM public.projects
       WHERE host_token_id = $1
         AND status IN ('active', 'paused')
       LIMIT 1
      `,
      [tokenId],
    )) as Array<{ id: string; slug: string; host_token_hmac: Buffer }>;

    const row = rows[0];
    if (!row) {
      // Still run the compare against a zero buffer so the
      // "unknown token" path takes roughly the same amount of
      // CPU as the "known id, wrong secret" path.
      const zero = Buffer.alloc(32);
      timingSafeEqual(expectedHmac, zero);
      throw new UnauthorizedException('unauthorized');
    }

    const stored = Buffer.isBuffer(row.host_token_hmac)
      ? row.host_token_hmac
      : Buffer.from(row.host_token_hmac);
    if (
      stored.length !== expectedHmac.length ||
      !timingSafeEqual(stored, expectedHmac)
    ) {
      throw new UnauthorizedException('unauthorized');
    }

    req.devloopHost = { project_id: row.id, project_slug: row.slug };
    return true;
  }
}
