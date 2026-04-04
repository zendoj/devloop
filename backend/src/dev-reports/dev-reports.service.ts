import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DevReport } from './entities/dev-report.entity';
import { DevReportFile } from './entities/dev-report-file.entity';
import * as fs from 'fs';
import * as path from 'path';

const DISPLAY_NAMES = [
  'Alice', 'Blake', 'Charlie', 'David', 'Emma', 'Frank', 'Grace', 'Henry',
  'Iris', 'Jack', 'Kate', 'Leo', 'Maya', 'Noah', 'Olivia', 'Paul',
  'Quinn', 'Ruby', 'Sam', 'Tom', 'Uma', 'Vera', 'Will', 'Zara',
];

@Injectable()
export class DevReportsService {
  constructor(
    @InjectRepository(DevReport)
    private readonly repo: Repository<DevReport>,
    @InjectRepository(DevReportFile)
    private readonly fileRepo: Repository<DevReportFile>,
  ) {}

  /** Generate a unique display ID like "Alice201" */
  private async generateDisplayId(): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const name = DISPLAY_NAMES[Math.floor(Math.random() * DISPLAY_NAMES.length)];
      const num = Math.floor(Math.random() * 999) + 1;
      const displayId = `${name}${num}`;
      const exists = await this.repo.findOne({ where: { displayId } });
      if (!exists) return displayId;
    }
    // Fallback: name + timestamp suffix
    const name = DISPLAY_NAMES[Math.floor(Math.random() * DISPLAY_NAMES.length)];
    return `${name}${Date.now() % 100000}`;
  }

  async create(data: {
    userId?: string;
    userEmail?: string;
    description: string;
    pageUrl: string;
    elementSelector?: string;
    elementText?: string;
    componentInfo?: string;
    screenshotPath?: string;
    viewport?: string;
    scrollPosition?: string;
    userAgent?: string;
    consoleErrors?: string[];
  }): Promise<DevReport> {
    const displayId = await this.generateDisplayId();
    const report = this.repo.create({ ...data, displayId });
    return this.repo.save(report);
  }

  async findAll(): Promise<DevReport[]> {
    return this.repo.find({ order: { createdAt: 'DESC' }, take: 100 });
  }

  async findByDisplayId(displayId: string): Promise<DevReport | null> {
    return this.repo.findOne({ where: { displayId } });
  }

  async createSequenceReport(data: {
    userId?: string;
    userEmail?: string;
    description: string;
    pageUrl: string;
    images: { data: string; comment?: string; timestamp: string; clicks?: any[]; annotations?: any[] }[];
    logs?: { timestamp: string; type: string; summary: string }[];
  }): Promise<{ displayId: string; id: string }> {
    const displayId = await this.generateDisplayId();
    const uploadsDir = path.join(process.cwd(), 'uploads', 'dev-reports', 'sequences');
    fs.mkdirSync(uploadsDir, { recursive: true });

    const sequence: NonNullable<DevReport['sequence']> = [];

    for (let i = 0; i < data.images.length; i++) {
      const img = data.images[i];
      const base64Data = img.data.replace(/^data:image\/\w+;base64,/, '');
      const filename = `${displayId}-${i}.png`;
      fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from(base64Data, 'base64'));
      sequence.push({
        index: i,
        imagePath: `uploads/dev-reports/sequences/${filename}`,
        comment: img.comment || null,
        timestamp: img.timestamp,
        clicks: img.clicks || [],
        annotations: img.annotations || [],
      });
    }

    // Use first image as screenshot
    const screenshotPath = sequence.length > 0 ? sequence[0].imagePath : null;

    const report = this.repo.create({
      displayId,
      userId: data.userId || null,
      userEmail: data.userEmail || null,
      description: data.description,
      pageUrl: data.pageUrl,
      screenshotPath,
      sequence,
      activityLogs: data.logs || null,
    });

    const saved = await this.repo.save(report);
    return { displayId: saved.displayId, id: saved.id };
  }

  async addThreadComment(id: string, author: string, text: string): Promise<DevReport | null> {
    const report = await this.repo.findOne({ where: { id } });
    if (!report) return null;
    const thread = Array.isArray(report.thread) ? [...report.thread] : [];
    thread.push({ author, text, timestamp: new Date().toISOString() });
    report.thread = thread;
    return this.repo.save(report);
  }

  async updateReport(id: string, data: { status?: string; assignee?: string; comment?: string; description?: string }): Promise<DevReport | null> {
    const update: Partial<DevReport> = {};
    if (data.status !== undefined) update.status = data.status;
    if (data.assignee !== undefined) update.assignee = data.assignee;
    if (data.comment !== undefined) update.comment = data.comment;
    if (data.description !== undefined) update.description = data.description;
    if (Object.keys(update).length > 0) {
      await this.repo.update(id, update);
    }
    return this.repo.findOne({ where: { id } });
  }

  /** Build a plain-text report summary */
  buildReportTxt(report: DevReport): string {
    const lines = [
      `Bug Report: ${report.displayId}`,
      `Status: ${report.status}`,
      `Assignee: ${report.assignee || '—'}`,
      `Date: ${report.createdAt}`,
      `Page: ${report.pageUrl}`,
      ``,
      `Description:`,
      report.description,
      ``,
      `Element selector: ${report.elementSelector || '—'}`,
      `Element text: ${report.elementText || '—'}`,
      `Component: ${report.componentInfo || '—'}`,
      `Viewport: ${report.viewport || '—'}`,
      `Scroll: ${report.scrollPosition || '—'}`,
      `User agent: ${report.userAgent || '—'}`,
      `Reported by: ${report.userEmail || '—'}`,
    ];
    if (report.comment) {
      lines.push(``, `Developer comment:`, report.comment);
    }
    if (report.consoleErrors && report.consoleErrors.length > 0) {
      lines.push(``, `Console errors:`);
      report.consoleErrors.forEach((e, i) => lines.push(`  ${i + 1}. ${e}`));
    }
    return lines.join('\n');
  }

  /* ── Shared Files ────────────────────────────────────────────────────── */

  async listFiles(): Promise<DevReportFile[]> {
    return this.fileRepo.find({ order: { createdAt: 'DESC' } });
  }

  async uploadFile(filename: string, base64Data: string, uploadedBy?: string): Promise<DevReportFile> {
    const uploadsDir = path.join(process.cwd(), 'uploads', 'dev-files');
    fs.mkdirSync(uploadsDir, { recursive: true });
    const safeFilename = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const filePath = path.join(uploadsDir, safeFilename);
    const data = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
    const file = this.fileRepo.create({
      filename,
      filePath: `uploads/dev-files/${safeFilename}`,
      uploadedBy: uploadedBy || null,
    });
    return this.fileRepo.save(file);
  }

  async deleteFile(id: string): Promise<{ deleted: boolean }> {
    const file = await this.fileRepo.findOne({ where: { id } });
    if (!file) return { deleted: false };
    const filePath = path.join(process.cwd(), file.filePath);
    try { fs.unlinkSync(filePath); } catch { /* file may not exist */ }
    await this.fileRepo.delete(id);
    return { deleted: true };
  }

  async getFilePath(id: string): Promise<{ filePath: string; filename: string } | null> {
    const file = await this.fileRepo.findOne({ where: { id } });
    if (!file) return null;
    return { filePath: path.join(process.cwd(), file.filePath), filename: file.filename };
  }

  async deleteReport(id: string): Promise<{ deleted: boolean }> {
    const report = await this.repo.findOne({ where: { id } });
    if (!report) return { deleted: false };
    // Remove screenshot file from disk
    if (report.screenshotPath) {
      const filePath = path.join(process.cwd(), report.screenshotPath);
      try { fs.unlinkSync(filePath); } catch { /* file may not exist */ }
    }
    await this.repo.delete(id);
    return { deleted: true };
  }
}
