import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../db/db.module';

export interface DeployListItem {
  id: string;
  project_slug: string;
  project_id: string;
  seq_no: number;
  action: string;
  deploy_sha: string;
  base_sha: string;
  target_branch: string;
  signing_key_id: string;
  issued_at: string;
  applied_status: string | null;
  applied_at: string | null;
  applied_sha: string | null;
  issued_by_task_id: string | null;
  issued_by_display_id: string | null;
  task_status: string | null;
  task_title: string | null;
  task_module: string | null;
  github_pr_number: number | null;
}

@Injectable()
export class DeploysService {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  public async list(limit = 100): Promise<DeployListItem[]> {
    const rows = (await this.ds.query(
      `
      SELECT
        dsh.id::text              AS id,
        p.slug                    AS project_slug,
        dsh.project_id::text      AS project_id,
        dsh.seq_no::int           AS seq_no,
        dsh.action::text          AS action,
        dsh.deploy_sha,
        dsh.base_sha,
        dsh.target_branch,
        dsh.signing_key_id,
        dsh.issued_at,
        dsh.applied_status::text  AS applied_status,
        dsh.applied_at,
        dsh.applied_sha,
        dsh.issued_by_task_id::text AS issued_by_task_id,
        at.display_id             AS issued_by_display_id,
        at.status::text           AS task_status,
        r.title                   AS task_title,
        at.module                 AS task_module,
        at.github_pr_number
      FROM public.desired_state_history dsh
      JOIN public.projects p ON p.id = dsh.project_id
      LEFT JOIN public.agent_tasks at ON at.id = dsh.issued_by_task_id
      LEFT JOIN public.reports r      ON r.id  = at.report_id
      ORDER BY dsh.issued_at DESC
      LIMIT $1
      `,
      [limit],
    )) as DeployListItem[];
    return rows;
  }
}
