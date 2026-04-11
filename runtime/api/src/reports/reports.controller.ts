import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { AddThreadDto, CreateReportDto } from './dtos/create-report.dto';
import {
  ReportDetail,
  ReportListItem,
  ReportsService,
} from './reports.service';

interface RequestWithSession extends FastifyRequest {
  session?: SessionContext;
}

@Controller('api/reports')
@UseGuards(SessionGuard)
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  }),
)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  public async list(
    @Req() req: RequestWithSession,
  ): Promise<{ items: ReportListItem[]; total: number }> {
    const session = req.session;
    if (!session) throw new UnauthorizedException('unauthorized');
    const items = await this.reports.list(session.role);
    return { items, total: items.length };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  public async create(
    @Body() body: CreateReportDto,
    @Req() req: RequestWithSession,
  ): Promise<{ report_id: string; task_id: string | null }> {
    const session = req.session;
    if (!session) throw new UnauthorizedException('unauthorized');
    if (session.role !== 'admin' && session.role !== 'super_admin') {
      throw new UnauthorizedException('unauthorized');
    }
    try {
      return await this.reports.create({
        projectId: body.project_id,
        title: body.title,
        description: body.description,
        reporterUserId: session.userId,
      });
    } catch (err) {
      const msg = (err as Error).message;
      // Convert FK violation to a 400 so the client sees a sensible error.
      if (msg.includes('violates foreign key constraint')) {
        throw new BadRequestException('project_id does not match any project');
      }
      if (msg.startsWith('title must') || msg.startsWith('description must')) {
        throw new BadRequestException(msg);
      }
      throw err;
    }
  }

  @Get(':id')
  public async getOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() req: RequestWithSession,
  ): Promise<ReportDetail> {
    const session = req.session;
    if (!session) throw new UnauthorizedException('unauthorized');
    return this.reports.getById(id, session.role);
  }

  @Post(':id/threads')
  @HttpCode(HttpStatus.CREATED)
  public async addThread(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: AddThreadDto,
    @Req() req: RequestWithSession,
  ): Promise<{ id: string }> {
    const session = req.session;
    if (!session) throw new UnauthorizedException('unauthorized');
    if (session.role !== 'admin' && session.role !== 'super_admin') {
      throw new UnauthorizedException('unauthorized');
    }
    // The thread author label is derived from the session's user_id
    // prefix; once the UI has a user profile fetch we can resolve
    // this to the real email or display name.
    return this.reports.addThread({
      reportId: id,
      authorKind: 'user',
      authorName: session.userId.slice(0, 8),
      body: body.body,
    });
  }
}
