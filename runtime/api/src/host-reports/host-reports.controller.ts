import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { ReportsService } from '../reports/reports.service';
import { HostReportDto } from './dtos/host-report.dto';
import { HostAuthGuard, HostContext } from './host-auth.guard';

interface RequestWithHost extends FastifyRequest {
  devloopHost?: HostContext;
}

/**
 * Host-authenticated bug report intake. Used by the
 * Ctrl+Shift+D widget in managed hosts (dev_energicrm's
 * frontend sends here via its backend relay).
 *
 * Auth: `Authorization: Host <token>` where <token> is the
 * per-project credential minted by ProjectsService.mintToken().
 * The HostAuthGuard attaches req.host = { project_id, slug }
 * on success; downstream handlers must NOT read project_id
 * from the request body.
 *
 * The endpoint reuses the main ReportsService.create path so
 * the classifier + orchestrator + audit chain all run
 * identically to a session-auth'd /api/reports call.
 */
@Controller('api/host-reports')
@UseGuards(HostAuthGuard)
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  }),
)
export class HostReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  public async create(
    @Body() body: HostReportDto,
    @Req() req: RequestWithHost,
  ): Promise<{ report_id: string; task_id: string | null }> {
    const host = req.devloopHost;
    if (!host) {
      throw new UnauthorizedException('unauthorized');
    }

    // Merge optional metadata into the description body so the
    // reviewer sees the full context without another DB column.
    const body_text =
      body.metadata === undefined || body.metadata.length === 0
        ? body.description
        : `${body.description}\n\n---\n\n\`\`\`\n${body.metadata}\n\`\`\``;

    try {
      return await this.reports.create({
        projectId: host.project_id,
        title: body.title,
        description: body_text,
        // Host-submitted reports have no DevLoop user identity —
        // reporter_user_id stays NULL. The reporter's CRM
        // identity (if any) lives inside body.metadata.
        reporterUserId: null,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('violates foreign key constraint')) {
        throw new BadRequestException('project no longer exists');
      }
      if (msg.startsWith('title must') || msg.startsWith('description must')) {
        throw new BadRequestException(msg);
      }
      throw err;
    }
  }
}
