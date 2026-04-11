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
import { AgentConfigListItem, AgentsService } from './agents.service';

interface RequestWithSession extends FastifyRequest {
  session?: SessionContext;
}

@Controller('api')
@UseGuards(SessionGuard)
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get('agents')
  public async list(
    @Req() req: RequestWithSession,
  ): Promise<{ items: AgentConfigListItem[]; total: number }> {
    const session = req.session;
    if (!session) throw new UnauthorizedException('unauthorized');
    const items = await this.agents.list();
    return { items, total: items.length };
  }
}
