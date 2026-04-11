import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { SessionGuard } from '../auth/guards/session.guard';
import type { SessionContext } from '../auth/services/session.service';
import {
  Stats,
  TaskDetail,
  TaskListItem,
  TasksService,
} from './tasks.service';

interface RequestWithSession extends FastifyRequest {
  session?: SessionContext;
}

interface RejectBody {
  feedback: string;
  files?: Array<{ name: string; content_base64: string }>;
}

interface ThreadBody {
  body: string;
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

  @Get('tasks/:id')
  public async getOne(
    @Req() req: RequestWithSession,
    @Param('id') id: string,
  ): Promise<TaskDetail> {
    const session = req.session;
    if (!session) throw new UnauthorizedException('unauthorized');
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      throw new BadRequestException('invalid id');
    }
    const task = await this.tasks.getOne(id, session.role);
    if (!task) throw new NotFoundException('task not found');
    return task;
  }

  @Post('tasks/:id/approve')
  @HttpCode(HttpStatus.OK)
  public async approve(
    @Req() req: RequestWithSession,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    const session = req.session;
    if (!session) throw new UnauthorizedException('unauthorized');
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      throw new BadRequestException('invalid id');
    }
    try {
      await this.tasks.approve(id, session.userId);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return { ok: true };
  }

  @Post('tasks/:id/reject')
  @HttpCode(HttpStatus.OK)
  public async reject(
    @Req() req: RequestWithSession,
    @Param('id') id: string,
    @Body() body: RejectBody,
  ): Promise<{ ok: true }> {
    const session = req.session;
    if (!session) throw new UnauthorizedException('unauthorized');
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      throw new BadRequestException('invalid id');
    }
    if (!body || typeof body.feedback !== 'string') {
      throw new BadRequestException('feedback required');
    }
    // Decode base64 file contents server-side so the DB stores
    // plaintext for text files (reviewable in psql) and the
    // worker can drop them straight into the worktree as real
    // files. Cap at 5 files, 1 MB each — human feedback should
    // not be dumping 50MB screen-recordings into the pipeline.
    const MAX_FILES = 5;
    const MAX_BYTES = 1_000_000;
    const files = (body.files ?? []).slice(0, MAX_FILES).map((f) => {
      if (typeof f.name !== 'string' || f.name.length === 0) {
        throw new BadRequestException('file.name required');
      }
      if (typeof f.content_base64 !== 'string') {
        throw new BadRequestException('file.content_base64 required');
      }
      const buf = Buffer.from(f.content_base64, 'base64');
      if (buf.length > MAX_BYTES) {
        throw new BadRequestException(
          `file ${f.name} too large (${buf.length} > ${MAX_BYTES} bytes)`,
        );
      }
      // Store base64 in DB — the worker decodes on the way out.
      return {
        name: f.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128),
        content: f.content_base64,
        size: buf.length,
      };
    });
    try {
      await this.tasks.reject(id, session.userId, body.feedback, files);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return { ok: true };
  }

  @Post('tasks/:id/thread')
  @HttpCode(HttpStatus.OK)
  public async addThread(
    @Req() req: RequestWithSession,
    @Param('id') id: string,
    @Body() body: ThreadBody,
  ): Promise<{ id: string }> {
    const session = req.session;
    if (!session) throw new UnauthorizedException('unauthorized');
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      throw new BadRequestException('invalid id');
    }
    if (!body || typeof body.body !== 'string') {
      throw new BadRequestException('body required');
    }
    try {
      return await this.tasks.addThreadMessage(
        id,
        `user:${session.userId}`,
        body.body,
      );
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Get('overview/stats')
  public async stats(@Req() req: RequestWithSession): Promise<Stats> {
    const session = req.session;
    if (!session) throw new UnauthorizedException('unauthorized');
    return this.tasks.stats(session.role);
  }
}
