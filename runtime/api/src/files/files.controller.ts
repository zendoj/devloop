import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import { SessionGuard } from '../auth/guards/session.guard';
import type { SessionContext } from '../auth/services/session.service';
import { FilesService, StoredFile } from './files.service';

interface RequestWithSession extends FastifyRequest {
  session?: SessionContext;
}

/**
 * Files sidebar endpoints — operator scratchpad for uploads.
 *
 * Auth: SessionGuard (same as tasks/projects).
 *
 * Intake is JSON {name, content_base64} rather than multipart
 * so we don't need to pull in @fastify/multipart just for this.
 * The sidebar component encodes files with FileReader before
 * POSTing. 50 MB cap matches the service layer.
 */
@Controller('api/files')
@UseGuards(SessionGuard)
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Get()
  public async list(
    @Req() req: RequestWithSession,
  ): Promise<{ items: StoredFile[]; total: number }> {
    if (!req.session) throw new UnauthorizedException('unauthorized');
    const items = await this.files.list();
    return { items, total: items.length };
  }

  @Post()
  public async upload(
    @Req() req: RequestWithSession,
  ): Promise<StoredFile> {
    if (!req.session) throw new UnauthorizedException('unauthorized');
    // @fastify/multipart adds req.file() / req.isMultipart()
    // to the fastify request. Use them via a loose cast since
    // the Nest type for @Req doesn't carry the plugin types.
    const reqAny = req as unknown as {
      isMultipart: () => boolean;
      file: () => Promise<
        | {
            filename: string;
            mimetype: string;
            toBuffer: () => Promise<Buffer>;
          }
        | undefined
      >;
    };
    if (typeof reqAny.isMultipart !== 'function' || !reqAny.isMultipart()) {
      throw new BadRequestException('multipart/form-data required');
    }
    const file = await reqAny.file();
    if (!file) {
      throw new BadRequestException('no file in multipart body');
    }
    const buf = await file.toBuffer();
    if (buf.length === 0) {
      throw new BadRequestException('empty file');
    }
    return this.files.save(file.filename, buf);
  }

  @Get(':name')
  public async download(
    @Req() req: RequestWithSession,
    @Param('name') name: string,
    @Res() res: FastifyReply,
  ): Promise<void> {
    if (!req.session) throw new UnauthorizedException('unauthorized');
    const bytes = await this.files.read(name);
    const ext = name.includes('.') ? name.split('.').pop() ?? '' : '';
    const mime = guessMime(ext);
    await res
      .header('Content-Type', mime)
      .header('Content-Length', String(bytes.length))
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .send(bytes);
  }

  @Delete(':name')
  public async remove(
    @Req() req: RequestWithSession,
    @Param('name') name: string,
  ): Promise<{ ok: true }> {
    if (!req.session) throw new UnauthorizedException('unauthorized');
    await this.files.delete(name);
    return { ok: true };
  }
}

function guessMime(ext: string): string {
  const lower = ext.toLowerCase();
  switch (lower) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    case 'webp':
      return 'image/webp';
    case 'pdf':
      return 'application/pdf';
    case 'json':
      return 'application/json';
    case 'txt':
    case 'md':
    case 'log':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}
