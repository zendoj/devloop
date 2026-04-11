import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../db/db.module';

/**
 * Shape returned by GET /api/reports list endpoint. No reporter_user_id
 * is ever leaked to avoid cross-user enumeration before ACLs ship.
 */
export interface ReportListItem {
  id: string;
  project_id: string;
  project_slug: string;
  title: string;
  status: string;
  risk_tier: string | null;
  created_at: string;
  triaged_at: string | null;
  resolved_at: string | null;
  has_task: boolean;
  task_display_id: string | null;
}

export interface ReportDetail extends ReportListItem {
  description: string;
  corrected_description: string | null;
  threads: ReportThread[];
}

export interface ReportThread {
  id: string;
  author_kind: string;
  author_name: string;
  body: string;
  created_at: string;
}

export interface CreateReportInput {
  projectId: string;
  title: string;
  description: string;
  reporterUserId: string | null;
}

export interface AddThreadInput {
  reportId: string;
  authorKind: 'user' | 'agent' | 'system';
  authorName: string;
  body: string;
}

@Injectable()
export class ReportsService {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  /**
   * List recent reports visible to the caller. Fas 1c: admins see all,
   * lesser roles see none. Per-project ACLs ship later.
   */
  public async list(callerRole: string, limit = 200): Promise<ReportListItem[]> {
    if (callerRole !== 'admin' && callerRole !== 'super_admin') {
      return [];
    }
    const boundedLimit = Math.min(Math.max(limit, 1), 500);
    const rows = (await this.ds.query(
      `
      SELECT
        r.id,
        r.project_id,
        p.slug AS project_slug,
        r.title,
        r.status::text AS status,
        r.risk_tier::text AS risk_tier,
        r.created_at,
        r.triaged_at,
        r.resolved_at,
        at.id          AS task_id,
        at.display_id  AS task_display_id
      FROM public.reports r
      JOIN public.projects p ON p.id = r.project_id
      LEFT JOIN LATERAL (
        SELECT id, display_id
          FROM public.agent_tasks
         WHERE report_id = r.id
         ORDER BY created_at DESC
         LIMIT 1
      ) at ON TRUE
      ORDER BY r.created_at DESC
      LIMIT $1
      `,
      [boundedLimit],
    )) as Array<{
      id: string;
      project_id: string;
      project_slug: string;
      title: string;
      status: string;
      risk_tier: string | null;
      created_at: Date;
      triaged_at: Date | null;
      resolved_at: Date | null;
      task_id: string | null;
      task_display_id: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      project_id: r.project_id,
      project_slug: r.project_slug,
      title: r.title,
      status: r.status,
      risk_tier: r.risk_tier,
      created_at: new Date(r.created_at).toISOString(),
      triaged_at: r.triaged_at === null ? null : new Date(r.triaged_at).toISOString(),
      resolved_at:
        r.resolved_at === null ? null : new Date(r.resolved_at).toISOString(),
      has_task: r.task_id !== null,
      task_display_id: r.task_display_id,
    }));
  }

  /**
   * Look up a single report with its thread. 404 if not found; Fas 1c
   * does not gate per-project yet so admins see all.
   */
  public async getById(id: string, callerRole: string): Promise<ReportDetail> {
    if (callerRole !== 'admin' && callerRole !== 'super_admin') {
      throw new NotFoundException('report not found');
    }
    const reportRows = (await this.ds.query(
      `
      SELECT
        r.id,
        r.project_id,
        p.slug AS project_slug,
        r.title,
        r.description,
        r.corrected_description,
        r.status::text AS status,
        r.risk_tier::text AS risk_tier,
        r.created_at,
        r.triaged_at,
        r.resolved_at,
        at.id          AS task_id,
        at.display_id  AS task_display_id
      FROM public.reports r
      JOIN public.projects p ON p.id = r.project_id
      LEFT JOIN LATERAL (
        SELECT id, display_id
          FROM public.agent_tasks
         WHERE report_id = r.id
         ORDER BY created_at DESC
         LIMIT 1
      ) at ON TRUE
      WHERE r.id = $1
      `,
      [id],
    )) as Array<{
      id: string;
      project_id: string;
      project_slug: string;
      title: string;
      description: string;
      corrected_description: string | null;
      status: string;
      risk_tier: string | null;
      created_at: Date;
      triaged_at: Date | null;
      resolved_at: Date | null;
      task_id: string | null;
      task_display_id: string | null;
    }>;

    const r = reportRows[0];
    if (!r) {
      throw new NotFoundException('report not found');
    }

    const threadRows = (await this.ds.query(
      `
      SELECT id, author_kind::text AS author_kind, author_name, body, created_at
        FROM public.report_threads
       WHERE report_id = $1
       ORDER BY created_at ASC, id ASC
      `,
      [id],
    )) as Array<{
      id: string;
      author_kind: string;
      author_name: string;
      body: string;
      created_at: Date;
    }>;

    return {
      id: r.id,
      project_id: r.project_id,
      project_slug: r.project_slug,
      title: r.title,
      description: r.description,
      corrected_description: r.corrected_description,
      status: r.status,
      risk_tier: r.risk_tier,
      created_at: new Date(r.created_at).toISOString(),
      triaged_at: r.triaged_at === null ? null : new Date(r.triaged_at).toISOString(),
      resolved_at:
        r.resolved_at === null ? null : new Date(r.resolved_at).toISOString(),
      has_task: r.task_id !== null,
      task_display_id: r.task_display_id,
      threads: threadRows.map((t) => ({
        id: t.id,
        author_kind: t.author_kind,
        author_name: t.author_name,
        body: t.body,
        created_at: new Date(t.created_at).toISOString(),
      })),
    };
  }

  /**
   * Create a new report + call orchestrate_task_for_report in the same
   * transaction so either both rows land or neither does.
   */
  public async create(input: CreateReportInput): Promise<{ report_id: string; task_id: string | null }> {
    const title = input.title.trim();
    const description = input.description.trim();
    if (title.length === 0 || title.length > 200) {
      throw new Error('title must be 1..200 chars');
    }
    if (description.length === 0 || description.length > 50_000) {
      throw new Error('description must be 1..50000 chars');
    }

    return this.ds.transaction(async (manager) => {
      const inserted = (await manager.query(
        `
        INSERT INTO public.reports (project_id, title, description, reporter_user_id)
        VALUES ($1, $2, $3, $4)
        RETURNING id
        `,
        [input.projectId, title, description, input.reporterUserId],
      )) as Array<{ id: string }>;
      const reportId = inserted[0]?.id;
      if (!reportId) {
        throw new Error('reports insert did not return id');
      }

      const taskRows = (await manager.query(
        `SELECT public.orchestrate_task_for_report($1) AS task_id`,
        [reportId],
      )) as Array<{ task_id: string | null }>;
      const taskId = taskRows[0]?.task_id ?? null;

      return { report_id: reportId, task_id: taskId };
    });
  }

  public async addThread(input: AddThreadInput): Promise<{ id: string }> {
    const body = input.body.trim();
    const authorName = input.authorName.trim();
    if (body.length === 0 || body.length > 10_000) {
      throw new Error('body must be 1..10000 chars');
    }
    if (authorName.length === 0 || authorName.length > 128) {
      throw new Error('author_name must be 1..128 chars');
    }
    if (!['user', 'agent', 'system'].includes(input.authorKind)) {
      throw new Error(`invalid author_kind: ${input.authorKind}`);
    }

    // Verify report exists.
    const exists = (await this.ds.query(
      `SELECT 1 FROM public.reports WHERE id = $1 LIMIT 1`,
      [input.reportId],
    )) as Array<{ '?column?': number }>;
    if (exists.length === 0) {
      throw new NotFoundException('report not found');
    }

    const rows = (await this.ds.query(
      `
      INSERT INTO public.report_threads (report_id, author_kind, author_name, body)
      VALUES ($1, $2::public.thread_author_enum, $3, $4)
      RETURNING id
      `,
      [input.reportId, input.authorKind, authorName, body],
    )) as Array<{ id: string }>;
    const id = rows[0]?.id;
    if (!id) {
      throw new Error('thread insert did not return id');
    }
    return { id };
  }
}
