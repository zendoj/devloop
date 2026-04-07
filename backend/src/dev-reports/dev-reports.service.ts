import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { DevReport } from './entities/dev-report.entity';
import { DevReportFile } from './entities/dev-report-file.entity';
import { FeatureIdea } from './entities/feature-idea.entity';
import * as fs from 'fs';
import * as path from 'path';

const DISPLAY_NAMES = [
  'Arne', 'Bjorn', 'Carl', 'David', 'Erik', 'Fredrik', 'Gustav', 'Henrik',
  'Ingvar', 'Johan', 'Karl', 'Lars', 'Magnus', 'Nils', 'Oscar', 'Per',
  'Ragnar', 'Sven', 'Thomas', 'Ulf', 'Viktor', 'Wilhelm',
  'Anna', 'Britt', 'Carin', 'Dagny', 'Eva', 'Frida', 'Greta', 'Hilda',
  'Ingrid', 'Julia', 'Karin', 'Lisa', 'Maria', 'Nina', 'Olga', 'Petra',
];

@Injectable()
export class DevReportsService {
  constructor(
    @InjectRepository(DevReport)
    private readonly repo: Repository<DevReport>,
    @InjectRepository(DevReportFile)
    private readonly fileRepo: Repository<DevReportFile>,
    @InjectRepository(FeatureIdea)
    private readonly ideaRepo: Repository<FeatureIdea>,
    private readonly config: ConfigService,
  ) {}

  /** Generate a unique display ID like "Arne201" */
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
    debugInfo?: Record<string, any>;
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

  async deleteThreadComment(id: string, index: number): Promise<DevReport | null> {
    const report = await this.repo.findOne({ where: { id } });
    if (!report) return null;
    const thread = Array.isArray(report.thread) ? [...report.thread] : [];
    if (index >= 0 && index < thread.length) {
      thread.splice(index, 1);
      report.thread = thread;
      return this.repo.save(report);
    }
    return report;
  }

  async addThreadComment(id: string, author: string, text: string): Promise<DevReport | null> {
    const report = await this.repo.findOne({ where: { id } });
    if (!report) return null;
    const thread = Array.isArray(report.thread) ? [...report.thread] : [];
    thread.push({ author, text, timestamp: new Date().toISOString() });
    report.thread = thread;
    return this.repo.save(report);
  }

  async updateReport(id: string, data: { status?: string; assignee?: string; comment?: string; description?: string; correctedDescription?: string }): Promise<DevReport | null> {
    const update: Partial<DevReport> = {};
    if (data.status !== undefined) update.status = data.status;
    if (data.assignee !== undefined) update.assignee = data.assignee;
    if (data.comment !== undefined) update.comment = data.comment;
    if (data.description !== undefined) update.description = data.description;
    if (data.correctedDescription !== undefined) update.correctedDescription = data.correctedDescription;
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
    if ((report as any).debugInfo) {
      const di = (report as any).debugInfo;
      if (di.css) {
        lines.push(``, `CSS Computed Styles:`);
        Object.entries(di.css).forEach(([k, v]) => lines.push(`  ${k}: ${v}`));
      }
      if (di.rect) {
        lines.push(``, `Element Size: ${di.rect.w}x${di.rect.h} at (${di.rect.x}, ${di.rect.y})`);
      }
      if (di.parentChain) {
        lines.push(`Parent chain: ${di.parentChain.join(' → ')}`);
      }
      if (di.recentApiCalls && di.recentApiCalls.length > 0) {
        lines.push(``, `Recent API calls:`);
        di.recentApiCalls.forEach((c: any) => lines.push(`  ${c.url} (${c.duration}ms) status=${c.status}`));
      }
    }
    return lines.join('\n');
  }

  /* -- Shared Files ------------------------------------------------------ */

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

  async saveFileRecord(filename: string, filePath: string, uploadedBy?: string | null): Promise<DevReportFile> {
    const file = this.fileRepo.create({ filename, filePath, uploadedBy: uploadedBy || null });
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

  /* -- Feature Ideas ----------------------------------------------------- */

  async listIdeas(): Promise<FeatureIdea[]> {
    return this.ideaRepo.find({ order: { createdAt: 'DESC' } });
  }

  async createIdea(data: { description: string; pageUrl?: string; imagePath?: string; createdBy?: string }): Promise<FeatureIdea> {
    return this.ideaRepo.save(this.ideaRepo.create(data));
  }

  async deleteIdea(id: string): Promise<void> {
    await this.ideaRepo.delete(id);
  }

  async convertIdeaToTask(id: string): Promise<{ displayId: string } | null> {
    const idea = await this.ideaRepo.findOne({ where: { id } });
    if (!idea) return null;
    const displayId = await this.generateDisplayId();
    const report = this.repo.create({
      displayId,
      description: idea.description,
      pageUrl: idea.pageUrl || '',
      screenshotPath: idea.imagePath || null,
      userEmail: idea.createdBy || null,
    });
    await this.repo.save(report);
    idea.convertedToTask = true;
    idea.taskDisplayId = displayId;
    await this.ideaRepo.save(idea);
    return { displayId };
  }

  /* -- AI Code Review ---------------------------------------------------- */

  async runAiReview(id: string, codeDiff: string): Promise<any> {
    const report = await this.repo.findOne({ where: { id } });
    if (!report) return null;

    const apiKey = this.config.get('OPENAI_API_KEY', '');
    if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

    const model = report.aiReviewModel || 'gpt-4o';
    const round = (report.aiReviewResults?.length || 0) + 1;

    const { data } = await axios.post('https://api.openai.com/v1/chat/completions', {
      model,
      messages: [
        { role: 'system', content: 'You are a senior code reviewer. Review the code changes and give a score from 1-10 (10 = perfect). Be specific about issues. Respond in JSON: {"score": N, "feedback": "..."}' },
        { role: 'user', content: `Review these code changes for bugs, security issues, and quality:\n\n${codeDiff}\n\nContext: ${report.description}` },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    });

    const content = data.choices?.[0]?.message?.content || '{}';
    let parsed: any;
    try { parsed = JSON.parse(content); } catch { parsed = { score: 0, feedback: content }; }

    const result = {
      round,
      score: parsed.score || 0,
      feedback: parsed.feedback || 'No feedback',
      model,
      timestamp: new Date().toISOString(),
    };

    const results = [...(report.aiReviewResults || []), result];
    report.aiReviewResults = results;
    await this.repo.save(report);

    return result;
  }

  async toggleAiReview(id: string, enabled: boolean, model?: string): Promise<DevReport | null> {
    const update: any = { aiReviewEnabled: enabled };
    if (model) update.aiReviewModel = model;
    await this.repo.update(id, update);
    return this.repo.findOne({ where: { id } });
  }
}
