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
import { TasksService } from '../tasks/tasks.service';
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
  constructor(
    private readonly reports: ReportsService,
    private readonly tasks: TasksService,
  ) {}

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

    // Fas I: rich-report attachments (screenshot, console log,
    // network log, state dump). Per-attachment 2 MB, total 8 MB.
    // Anything bigger the DevLoop intake rejects as 413 so the
    // CRM widget can decide to trim/drop before re-sending.
    const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
    const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
    const attachments: Array<{
      name: string;
      mime_type: string;
      content_base64: string;
      size: number;
    }> = [];
    let totalBytes = 0;
    for (const a of body.attachments ?? []) {
      const buf = Buffer.from(a.content_base64, 'base64');
      if (buf.length > MAX_ATTACHMENT_BYTES) {
        throw new BadRequestException(
          `attachment ${a.name} too large (${buf.length} > ${MAX_ATTACHMENT_BYTES} bytes)`,
        );
      }
      totalBytes += buf.length;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new BadRequestException(
          `total attachment size exceeds ${MAX_TOTAL_BYTES} bytes`,
        );
      }
      attachments.push({
        name: a.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255),
        mime_type: a.mime_type ?? 'application/octet-stream',
        content_base64: a.content_base64,
        size: buf.length,
      });
    }

    try {
      return await this.reports.create({
        projectId: host.project_id,
        title: body.title,
        description: body_text,
        // Host-submitted reports have no DevLoop user identity —
        // reporter_user_id stays NULL. The reporter's CRM
        // identity (if any) lives inside body.metadata.
        reporterUserId: null,
        attachments,
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

  /**
   * Host-auth'd "not working" reject flow — the CRM widget's
   * Ctrl+Shift+D panel has an "X not working" checkbox that
   * routes submissions here instead of creating a new report.
   * Looks up the task by display_id within the project the
   * host token belongs to, then drives the same reject path
   * as the cookie-auth'd /api/tasks/:id/reject endpoint:
   * feedback + optional files → task_feedback → fence back to
   * assigned → worker re-runs Claude with the rejection files
   * in .devloop/feedback/attempt-N/.
   *
   * Only tasks currently in 'ready_for_test' can be rejected
   * this way. Attempting to reject a task in any other status
   * surfaces a 400.
   */
  @Post('reject')
  @HttpCode(HttpStatus.OK)
  public async reject(
    @Body()
    body: {
      task_display_id?: unknown;
      feedback?: unknown;
      files?: Array<{ name?: unknown; content_base64?: unknown }>;
    },
    @Req() req: RequestWithHost,
  ): Promise<{ ok: true; task_id: string }> {
    const host = req.devloopHost;
    if (!host) {
      throw new UnauthorizedException('unauthorized');
    }
    if (typeof body.task_display_id !== 'string') {
      throw new BadRequestException('task_display_id required');
    }
    if (typeof body.feedback !== 'string' || body.feedback.trim().length === 0) {
      throw new BadRequestException('feedback required');
    }
    // Strict T-<number> shape so we never inject weird display_id
    // values into the SELECT. Uppercase or lowercase T both OK.
    const displayId = body.task_display_id.trim();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(displayId)) {
      throw new BadRequestException('invalid task_display_id');
    }
    const task = await this.tasks.findByDisplayId(host.project_id, displayId);
    if (!task) {
      throw new BadRequestException(
        `task ${displayId} not found in project ${host.project_slug}`,
      );
    }
    if (task.status !== 'ready_for_test') {
      throw new BadRequestException(
        `task ${displayId} is in status '${task.status}', can only reject from 'ready_for_test'`,
      );
    }

    // Decode + size-cap attachments the same way the cookie-auth
    // reject endpoint does: max 5 files, 1 MB each.
    const MAX_FILES = 5;
    const MAX_BYTES = 1_000_000;
    const files: Array<{ name: string; content: string; size: number }> = [];
    for (const raw of (body.files ?? []).slice(0, MAX_FILES)) {
      if (typeof raw.name !== 'string' || typeof raw.content_base64 !== 'string') {
        throw new BadRequestException('each file needs name + content_base64');
      }
      const buf = Buffer.from(raw.content_base64, 'base64');
      if (buf.length > MAX_BYTES) {
        throw new BadRequestException(
          `file ${raw.name} too large (${buf.length} > ${MAX_BYTES})`,
        );
      }
      files.push({
        name: raw.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128),
        content: raw.content_base64,
        size: buf.length,
      });
    }

    try {
      await this.tasks.reject(
        task.id,
        null,
        body.feedback,
        files,
        `host:${host.project_slug}`,
      );
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return { ok: true, task_id: task.id };
  }
}
