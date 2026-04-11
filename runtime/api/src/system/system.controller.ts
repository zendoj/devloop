import {
  Controller,
  Get,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { SessionGuard } from '../auth/guards/session.guard';
import type { SessionContext } from '../auth/services/session.service';
import {
  AuditEventListItem,
  HealthProjectSummary,
  SettingsPayload,
  SystemService,
} from './system.service';

interface RequestWithSession extends FastifyRequest {
  session?: SessionContext;
}

@Controller('api')
@UseGuards(SessionGuard)
export class SystemController {
  constructor(private readonly system: SystemService) {}

  @Get('health')
  public async health(
    @Req() req: RequestWithSession,
  ): Promise<{ items: HealthProjectSummary[]; total: number }> {
    const session = req.session;
    if (!session) throw new UnauthorizedException('unauthorized');
    const items = await this.system.healthOverview();
    return { items, total: items.length };
  }

  @Get('audit')
  public async audit(
    @Req() req: RequestWithSession,
  ): Promise<{ items: AuditEventListItem[]; total: number }> {
    const session = req.session;
    if (!session) throw new UnauthorizedException('unauthorized');
    const items = await this.system.auditList();
    return { items, total: items.length };
  }

  @Get('settings')
  public async settings(
    @Req() req: RequestWithSession,
  ): Promise<SettingsPayload> {
    const session = req.session;
    if (!session) throw new UnauthorizedException('unauthorized');
    return this.system.settings();
  }
}
