import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../db/db.module';

export interface TaskListItem {
  id: string;
  display_id: string;
  project_id: string;
  project_slug: string;
  report_id: string;
  report_title: string;
  agent_name: string;
  module: string;
  risk_tier: string;
  status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface Stats {
  projects_total: number;
  reports_open: number;
  tasks_active: number;
  deploys_last_7d: number;
}

@Injectable()
export class TasksService {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  public async list(callerRole: string, limit = 200): Promise<TaskListItem[]> {
    if (callerRole !== 'admin' && callerRole !== 'super_admin') {
      return [];
    }
    const boundedLimit = Math.min(Math.max(limit, 1), 500);

    const rows = (await this.ds.query(
      `
      SELECT
        at.id,
        at.display_id,
        at.project_id,
        p.slug AS project_slug,
        at.report_id,
        r.title AS report_title,
        at.agent_name,
        at.module,
        at.risk_tier::text AS risk_tier,
        at.status::text AS status,
        at.created_at,
        at.started_at,
        at.completed_at
      FROM public.agent_tasks at
      JOIN public.projects p ON p.id = at.project_id
      JOIN public.reports  r ON r.id = at.report_id
      ORDER BY at.created_at DESC
      LIMIT $1
      `,
      [boundedLimit],
    )) as Array<{
      id: string;
      display_id: string;
      project_id: string;
      project_slug: string;
      report_id: string;
      report_title: string;
      agent_name: string;
      module: string;
      risk_tier: string;
      status: string;
      created_at: Date;
      started_at: Date | null;
      completed_at: Date | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      display_id: r.display_id,
      project_id: r.project_id,
      project_slug: r.project_slug,
      report_id: r.report_id,
      report_title: r.report_title,
      agent_name: r.agent_name,
      module: r.module,
      risk_tier: r.risk_tier,
      status: r.status,
      created_at: new Date(r.created_at).toISOString(),
      started_at:
        r.started_at === null ? null : new Date(r.started_at).toISOString(),
      completed_at:
        r.completed_at === null ? null : new Date(r.completed_at).toISOString(),
    }));
  }

  /**
   * Overview dashboard stats: single SQL pass with aggregate counts
   * so the page loads in one round trip regardless of how many tables
   * it touches.
   */
  public async stats(callerRole: string): Promise<Stats> {
    if (callerRole !== 'admin' && callerRole !== 'super_admin') {
      return {
        projects_total: 0,
        reports_open: 0,
        tasks_active: 0,
        deploys_last_7d: 0,
      };
    }

    const rows = (await this.ds.query(
      `
      SELECT
        (SELECT COUNT(*) FROM public.projects)::int AS projects_total,
        (SELECT COUNT(*) FROM public.reports
          WHERE status IN ('new','triaged','in_progress','needs_info'))::int AS reports_open,
        (SELECT COUNT(*) FROM public.agent_tasks
          WHERE status NOT IN ('verified','rolled_back','rollback_failed','failed','cancelled'))::int AS tasks_active,
        (SELECT COUNT(*) FROM public.desired_state_history
          WHERE applied_status = 'success' AND applied_at > now() - interval '7 days')::int AS deploys_last_7d
      `,
    )) as Array<Stats>;
    return (
      rows[0] ?? {
        projects_total: 0,
        reports_open: 0,
        tasks_active: 0,
        deploys_last_7d: 0,
      }
    );
  }
}
