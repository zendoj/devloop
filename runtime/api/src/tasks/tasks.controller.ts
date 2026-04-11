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
import { Stats, TaskListItem, TasksService } from './tasks.service';

interface RequestWithSession extends FastifyRequest {
  session?: SessionContext;
}

@Controller('api')
@UseGuards(SessionGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get('tasks')
  public async list(
    @Req() req: RequestWithSession,
  ): Promise<{ items: TaskListItem[]; total: number }> {
    const session = req.session;
    if (!session) throw new UnauthorizedException('unauthorized');
    const items = await this.tasks.list(session.role);
    return { items, total: items.length };
  }

  @Get('overview/stats')
  public async stats(@Req() req: RequestWithSession): Promise<Stats> {
    const session = req.session;
    if (!session) throw new UnauthorizedException('unauthorized');
    return this.tasks.stats(session.role);
  }
}
