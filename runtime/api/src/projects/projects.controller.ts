import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { SessionGuard } from '../auth/guards/session.guard';
import type { SessionContext } from '../auth/services/session.service';
import { CreateProjectDto } from './dtos/create-project.dto';
import {
  CreatedProject,
  ProjectDetail,
  ProjectListItem,
  ProjectsService,
} from './projects.service';
import { isValidSlug } from './slug.util';

interface RequestWithSession extends FastifyRequest {
  session?: SessionContext;
}

@Controller('api/projects')
@UseGuards(SessionGuard)
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  }),
)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  public async list(
    @Req() req: RequestWithSession,
  ): Promise<{ items: ProjectListItem[]; total: number }> {
    const session = req.session;
    if (!session) throw new UnauthorizedException('unauthorized');
    const items = await this.projects.list(session.role);
    return { items, total: items.length };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  public async create(
    @Body() body: CreateProjectDto,
    @Req() req: RequestWithSession,
  ): Promise<CreatedProject> {
    const session = req.session;
    if (!session) throw new UnauthorizedException('unauthorized');
    if (session.role !== 'admin' && session.role !== 'super_admin') {
      throw new UnauthorizedException('unauthorized');
    }
    return this.projects.create({
      slug: body.slug,
      name: body.name,
      host_base_url: body.host_base_url,
      github_app_install_id: body.github_app_install_id,
      github_owner: body.github_owner,
      github_repo: body.github_repo,
      github_default_branch: body.github_default_branch ?? 'main',
      created_by: session.userId,
    });
  }

  @Get(':slug')
  public async getBySlug(
    @Param('slug') slug: string,
    @Req() req: RequestWithSession,
  ): Promise<ProjectDetail> {
    const session = req.session;
    if (!session) throw new UnauthorizedException('unauthorized');
    // Enforce the FULL slug contract (regex + length bounds) before
    // the DB hit. Malformed route params should be 400, not 401 —
    // the session is already valid at this point.
    if (!isValidSlug(slug)) {
      throw new BadRequestException('invalid slug');
    }
    return this.projects.getBySlug(slug, session.role);
  }
}
