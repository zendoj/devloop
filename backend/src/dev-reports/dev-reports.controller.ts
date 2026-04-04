import { Controller, Post, Get, Patch, Delete, Body, Param, Req, Res, UseGuards, NotFoundException } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { DevReportsService } from './dev-reports.service';
import * as fs from 'fs';
import * as path from 'path';
import * as archiver from 'archiver';

@Controller('dev-reports')
@UseGuards(JwtAuthGuard)
export class DevReportsController {
  constructor(private readonly service: DevReportsService) {}

  @Post()
  async create(@Body() body: any, @Req() req: any) {
    const userId = req.user?.sub || req.user?.id || null;
    const userEmail = req.user?.email || null;

    // Save screenshot to disk if provided
    let screenshotPath: string | undefined;
    if (body.screenshot && typeof body.screenshot === 'string' && body.screenshot.startsWith('data:image/')) {
      const uploadsDir = path.join(process.cwd(), 'uploads', 'dev-reports');
      fs.mkdirSync(uploadsDir, { recursive: true });
      const base64Data = body.screenshot.replace(/^data:image\/\w+;base64,/, '');
      const filename = `${Date.now()}.png`;
      const filePath = path.join(uploadsDir, filename);
      fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
      screenshotPath = `uploads/dev-reports/${filename}`;
    }

    const report = await this.service.create({
      userId,
      userEmail,
      description: body.description || '',
      pageUrl: body.pageUrl || '',
      elementSelector: body.elementSelector || null,
      elementText: body.elementText?.slice(0, 500) || null,
      componentInfo: body.componentInfo || null,
      screenshotPath,
      viewport: body.viewport || null,
      scrollPosition: body.scrollPosition || null,
      userAgent: body.userAgent || null,
      consoleErrors: body.consoleErrors || null,
    });
    return { displayId: report.displayId, id: report.id };
  }

  @Post('sequence')
  async createSequenceReport(@Body() body: any, @Req() req: any) {
    const userId = req.user?.sub || req.user?.id || null;
    const userEmail = req.user?.email || null;
    return this.service.createSequenceReport({
      userId,
      userEmail,
      description: body.description || '',
      pageUrl: body.pageUrl || '',
      images: body.images || [],
    });
  }

  /* ── Shared Files ────────────────────────────────────────────────────── */

  @Get('files')
  async listFiles() {
    return this.service.listFiles();
  }

  @Post('files/upload')
  async uploadFile(@Body() body: { filename: string; data: string }, @Req() req: any) {
    const uploadedBy = req.user?.email || null;
    return this.service.uploadFile(body.filename, body.data, uploadedBy);
  }

  @Get('files/:id/download')
  async downloadFile(@Param('id') id: string, @Res() res: any) {
    const result = await this.service.getFilePath(id);
    if (!result) throw new NotFoundException('File not found');
    const fs = require('fs');
    if (!fs.existsSync(result.filePath)) throw new NotFoundException('File missing from disk');
    const buf = fs.readFileSync(result.filePath);
    res.type('application/octet-stream');
    res.header('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(buf);
  }

  @Delete('files/:id')
  async deleteFile(@Param('id') id: string) {
    return this.service.deleteFile(id);
  }

  @Get()
  async findAll() {
    return this.service.findAll();
  }

  @Get(':id/screenshot')
  async getScreenshot(@Param('id') id: string, @Res() res: any) {
    const report = await this.service.findByDisplayId(id);
    if (!report || !report.screenshotPath) throw new NotFoundException('Screenshot not found');
    const filePath = path.join(process.cwd(), report.screenshotPath);
    if (!fs.existsSync(filePath)) throw new NotFoundException('Screenshot file missing');
    const buf = fs.readFileSync(filePath);
    res.type('image/png');
    res.header('Content-Disposition', `attachment; filename="${report.displayId}-screenshot.png"`);
    res.send(buf);
  }

  @Get(':id/report.txt')
  async getReportTxt(@Param('id') id: string, @Res() res: any) {
    const report = await this.service.findByDisplayId(id);
    if (!report) throw new NotFoundException('Report not found');
    const txt = this.service.buildReportTxt(report);
    res.type('text/plain');
    res.header('Content-Disposition', `attachment; filename="${report.displayId}-report.txt"`);
    res.send(txt);
  }

  @Get(':id/download.zip')
  async getZip(@Param('id') id: string, @Res() res: any) {
    const report = await this.service.findByDisplayId(id);
    if (!report) throw new NotFoundException('Report not found');

    // Write zip to temp file, then send as buffer (Fastify-safe)
    const tmpDir = path.join(process.cwd(), 'uploads', 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `${report.displayId}-${Date.now()}.zip`);
    const output = fs.createWriteStream(tmpFile);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(output);

    // Add report txt
    const txt = this.service.buildReportTxt(report);
    archive.append(txt, { name: `${report.displayId}-report.txt` });

    // Add screenshot if exists
    if (report.screenshotPath) {
      const screenshotFile = path.join(process.cwd(), report.screenshotPath);
      if (fs.existsSync(screenshotFile)) {
        archive.file(screenshotFile, { name: `${report.displayId}-screenshot.png` });
      }
    }

    await archive.finalize();
    await new Promise<void>((resolve) => output.on('close', resolve));

    const buf = fs.readFileSync(tmpFile);
    fs.unlinkSync(tmpFile);

    res.type('application/zip');
    res.header('Content-Disposition', `attachment; filename="${report.displayId}.zip"`);
    res.send(buf);
  }

  @Get(':displayId')
  async findOne(@Param('displayId') displayId: string) {
    return this.service.findByDisplayId(displayId);
  }

  @Post(':id/thread')
  async addThreadComment(@Param('id') id: string, @Body() body: { author: string; text: string }, @Req() req: any) {
    const author = body.author || req.user?.email || 'Okänd';
    return this.service.addThreadComment(id, author, body.text);
  }

  @Patch(':id')
  async updateReport(@Param('id') id: string, @Body() body: { status?: string; assignee?: string; comment?: string; description?: string }) {
    return this.service.updateReport(id, body);
  }

  @Delete(':id')
  async deleteReport(@Param('id') id: string) {
    return this.service.deleteReport(id);
  }
}
