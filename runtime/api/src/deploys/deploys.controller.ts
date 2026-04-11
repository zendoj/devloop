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
import { DeployListItem, DeploysService } from './deploys.service';

interface RequestWithSession extends FastifyRequest {
  session?: SessionContext;
}

@Controller('api')
@UseGuards(SessionGuard)
export class DeploysController {
  constructor(private readonly deploys: DeploysService) {}

  @Get('deploys')
  public async list(
    @Req() req: RequestWithSession,
  ): Promise<{ items: DeployListItem[]; total: number }> {
    const session = req.session;
    if (!session) throw new UnauthorizedException('unauthorized');
    const items = await this.deploys.list();
    return { items, total: items.length };
  }
}
