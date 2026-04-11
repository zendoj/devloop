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
import { ProjectsService, ProjectListItem } from './projects.service';

interface RequestWithSession extends FastifyRequest {
  session?: SessionContext;
}

@Controller('api/projects')
@UseGuards(SessionGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  /**
   * GET /projects
   * Session-guarded. Returns the caller's visible projects.
   *
   * Response shape:
   *   { items: ProjectListItem[], total: number }
   *
   * NOT cached. No sensitive fields (token HMACs, deploy paths) are
   * ever serialized to the client — the service layer filters them
   * at the SELECT.
   */
  @Get()
  public async list(
    @Req() req: RequestWithSession,
  ): Promise<{ items: ProjectListItem[]; total: number }> {
    const session = req.session;
    if (!session) {
      throw new UnauthorizedException('unauthorized');
    }
    const items = await this.projects.list(session.role);
    return { items, total: items.length };
  }
}
