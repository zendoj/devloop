import { Controller, Get, HttpCode } from '@nestjs/common';

/**
 * /healthz — liveness probe used by Nginx, systemd health checks,
 * and the host deploy agent during post-deploy verification.
 *
 * Fas 0.1: minimal stub that returns 200 unconditionally.
 * Fas 0.2+ will add DB ping and dependency checks per §3.4.1 / §3.1.2.
 */
@Controller('healthz')
export class HealthController {
  @Get()
  @HttpCode(200)
  check(): { ok: true } {
    return { ok: true };
  }
}
