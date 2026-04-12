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
          WHERE status NOT IN ('verified','accepted','rolled_back','rollback_failed','failed','cancelled'))::int AS tasks_active,
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

  /**
   * Fetch one task with all the detail the /tasks/:id view needs:
   * plan, diff metadata, reviewer notes, audit notes, feedback
   * history. One query with LEFT JOINs + a second query for the
   * per-task feedback rows.
   */
  public async getOne(
    id: string,
    callerRole: string,
  ): Promise<TaskDetail | null> {
    if (callerRole !== 'admin' && callerRole !== 'super_admin') {
      return null;
    }
    const rows = (await this.ds.query(
      `
      SELECT
        at.id::text               AS id,
        at.display_id,
        at.project_id::text       AS project_id,
        p.slug                    AS project_slug,
        p.github_owner,
        p.github_repo,
        at.report_id::text        AS report_id,
        r.title                   AS report_title,
        r.description             AS report_body,
        at.module,
        at.risk_tier::text        AS risk_tier,
        at.status::text           AS status,
        at.branch_name,
        at.plan,
        at.approved_base_sha,
        at.approved_head_sha,
        at.review_decision::text  AS review_decision,
        at.review_score,
        at.review_model_used,
        at.review_notes_md,
        at.audit_status,
        at.audit_notes_md,
        at.github_pr_number,
        at.merged_commit_sha,
        at.retry_count,
        at.lease_version,
        at.created_at,
        at.completed_at,
        at.human_approved_at,
        at.failure_reason
      FROM public.agent_tasks at
      JOIN public.projects p ON p.id = at.project_id
      JOIN public.reports  r ON r.id = at.report_id
      WHERE at.id = $1
      LIMIT 1
      `,
      [id],
    )) as Array<TaskDetail>;
    const task = rows[0];
    if (!task) return null;

    const feedback = (await this.ds.query(
      `
      SELECT
        id::int AS id,
        attempt_number,
        feedback_text,
        files,
        reported_at
      FROM public.task_feedback
      WHERE task_id = $1
      ORDER BY id DESC
      `,
      [id],
    )) as Array<TaskFeedbackRow>;

    const threads = (await this.ds.query(
      `
      SELECT
        id::text       AS id,
        author_kind::text AS author_kind,
        author_name,
        body,
        created_at
      FROM public.report_threads
      WHERE report_id = $1
      ORDER BY created_at ASC
      `,
      [task.report_id],
    )) as Array<ThreadRow>;

    const attachments = (await this.ds.query(
      `
      SELECT
        id::int        AS id,
        name,
        mime_type,
        size_bytes     AS size,
        content_base64,
        created_at
      FROM public.report_attachments
      WHERE report_id = $1
      ORDER BY id ASC
      `,
      [task.report_id],
    )) as Array<ReportAttachmentRow>;

    // Deploy activity: the applied desired_state (and any
    // rollback) for this task so the detail UI can show
    // "rebuilding frontend... / restarting pm2 / done" live.
    // One row per desired_state id attached to the task.
    const deployRows = (await this.ds.query(
      `
      SELECT
        dsh.id::text              AS id,
        dsh.action::text          AS action,
        dsh.issued_at,
        dsh.apply_started_at,
        dsh.applied_at,
        dsh.applied_status::text  AS applied_status,
        dsh.applied_log_excerpt,
        dsh.deploy_sha,
        CASE
          WHEN dsh.id = at.applied_desired_state_id THEN 'deploy'
          WHEN dsh.id = at.rollback_desired_state_id THEN 'rollback'
          ELSE 'other'
        END AS slot
      FROM public.agent_tasks at
      JOIN public.desired_state_history dsh
        ON dsh.id IN (at.applied_desired_state_id, at.rollback_desired_state_id)
      WHERE at.id = $1
      ORDER BY dsh.issued_at ASC
      `,
      [id],
    )) as Array<DeployActivityRow>;

    task.feedback = feedback;
    task.threads = threads;
    task.attachments = attachments;
    task.deploy_activity = deployRows;
    return task;
  }

  /**
   * Append a user-written message to the report thread attached
   * to this task. The thread lives on the report, not the task —
   * all attempts at fixing the same bug share one conversation.
   */
  public async addThreadMessage(
    taskId: string,
    authorName: string,
    body: string,
  ): Promise<{ id: string }> {
    // Look up the report_id for the task. Narrow SELECT so we
    // don't fetch the whole detail just to insert a thread.
    const rows = (await this.ds.query(
      `SELECT report_id::text AS report_id FROM public.agent_tasks WHERE id = $1`,
      [taskId],
    )) as Array<{ report_id: string }>;
    const reportId = rows[0]?.report_id;
    if (!reportId) {
      throw new Error('task not found');
    }

    const trimmedBody = body.trim();
    const trimmedAuthor = authorName.trim();
    if (trimmedBody.length === 0 || trimmedBody.length > 10_000) {
      throw new Error('body must be 1..10000 chars');
    }
    if (trimmedAuthor.length === 0 || trimmedAuthor.length > 128) {
      throw new Error('author_name must be 1..128 chars');
    }

    const inserted = (await this.ds.query(
      `
      INSERT INTO public.report_threads (report_id, author_kind, author_name, body)
      VALUES ($1, 'user'::public.thread_author_enum, $2, $3)
      RETURNING id::text AS id
      `,
      [reportId, trimmedAuthor, trimmedBody],
    )) as Array<{ id: string }>;
    const id = inserted[0]?.id;
    if (!id) {
      throw new Error('thread insert did not return id');
    }
    return { id };
  }

  /**
   * Approve a task (human acceptance test passed). Transitions
   * ready_for_test → accepted. Terminal.
   */
  public async approve(id: string, userId: string): Promise<void> {
    const row = (await this.ds.query(
      `SELECT lease_version FROM public.agent_tasks WHERE id = $1 AND status = 'ready_for_test'`,
      [id],
    )) as Array<{ lease_version: string | number }>;
    const lease = row[0]?.lease_version;
    if (lease === undefined) {
      throw new Error('task not in ready_for_test');
    }
    await this.ds.query(
      `
      SELECT public.fence_and_transition(
        $1, $2::bigint, 'ready_for_test'::public.task_status_enum,
        'accepted'::public.task_status_enum,
        $3::varchar(128), 'user'::public.actor_kind_enum,
        jsonb_build_object(
          'human_approved_at', now()::text,
          'human_approved_by', $4::text
        ),
        NULL::varchar(128)
      )
      `,
      [id, Number(lease), `user:${userId}`, userId],
    );
  }

  /**
   * Look up a task by display_id + project_id. Used by the
   * host-auth'd reject endpoint which only knows the display_id
   * (T-9) from the widget and the project_id from the host
   * token.
   */
  public async findByDisplayId(
    projectId: string,
    displayId: string,
  ): Promise<{ id: string; status: string } | null> {
    const rows = (await this.ds.query(
      `SELECT id::text AS id, status::text AS status
         FROM public.agent_tasks
        WHERE project_id = $1
          AND display_id = $2
        LIMIT 1`,
      [projectId, displayId],
    )) as Array<{ id: string; status: string }>;
    return rows[0] ?? null;
  }

  /**
   * Reject a task with feedback. Saves the feedback + files to
   * task_feedback and transitions ready_for_test → assigned so
   * Claude runs the task again with the feedback files copied
   * into the worktree on next worker spawn.
   *
   * userId may be null for host-auth'd rejects coming from the
   * CRM widget (no DevLoop user in that flow). actorName
   * controls the fence_and_transition actor string — defaults
   * to `user:${userId}` for the cookie-auth path, callers can
   * override to `host:${project_slug}` etc.
   */
  public async reject(
    id: string,
    userId: string | null,
    feedbackText: string,
    files: Array<{ name: string; content: string; size: number }>,
    actorName?: string,
  ): Promise<void> {
    if (!feedbackText || feedbackText.trim().length === 0) {
      throw new Error('feedback_text required');
    }
    const row = (await this.ds.query(
      `SELECT lease_version, retry_count FROM public.agent_tasks WHERE id = $1 AND status = 'ready_for_test'`,
      [id],
    )) as Array<{ lease_version: string | number; retry_count: number }>;
    const current = row[0];
    if (!current) {
      throw new Error('task not in ready_for_test');
    }

    const attemptNumber = Number(current.retry_count) + 1;

    await this.ds.transaction(async (m) => {
      // Save feedback row first so it's there when the worker
      // re-spawns Claude.
      await m.query(
        `
        INSERT INTO public.task_feedback
          (task_id, attempt_number, reported_by, feedback_text, files)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        `,
        [
          id,
          attemptNumber,
          userId,
          feedbackText.slice(0, 20000),
          JSON.stringify(
            files.map((f) => ({
              name: f.name,
              size: f.size,
              content: f.content, // base64 for binary, utf8 for text
            })),
          ),
        ],
      );

      // Transition ready_for_test → assigned. fence_and_transition
      // increments retry_count and keeps the module lock held.
      const resolvedActor =
        actorName ?? (userId ? `user:${userId}` : 'user:unknown');
      await m.query(
        `
        SELECT public.fence_and_transition(
          $1, $2::bigint, 'ready_for_test'::public.task_status_enum,
          'assigned'::public.task_status_enum,
          $3::varchar(128), 'user'::public.actor_kind_enum,
          jsonb_build_object('failure_reason', $4::text),
          NULL::varchar(128)
        )
        `,
        [
          id,
          Number(current.lease_version),
          resolvedActor,
          `human rejected with feedback (attempt ${attemptNumber})`,
        ],
      );
    });
  }

  /**
   * Manually recover a stuck task. Used when a task is in a
   * dead-end state (typically rollback_failed or failed) and an
   * operator has inspected the production host, confirmed the
   * state is sane, and wants to un-stuck the pipeline.
   *
   * Wraps the `recover_task` SQL proc which atomically:
   *   - releases deploy_mutex for this task
   *   - releases module_lock for this task
   *   - transitions to the target status
   *   - appends an audit_event row
   *
   * The caller's role is checked: only admin/super_admin can
   * trigger recovery.
   */
  public async recover(
    id: string,
    callerRole: string,
    callerUserId: string,
    targetStatus: string,
    reason: string,
  ): Promise<{ new_lease: number }> {
    if (callerRole !== 'admin' && callerRole !== 'super_admin') {
      throw new Error('only admin can recover tasks');
    }
    const allowed = new Set([
      'ready_for_test',
      'assigned',
      'failed',
      'cancelled',
    ]);
    if (!allowed.has(targetStatus)) {
      throw new Error(
        `illegal target status '${targetStatus}' (allowed: ${[...allowed].join(', ')})`,
      );
    }
    const trimmedReason = reason.trim().slice(0, 500);
    if (trimmedReason.length === 0) {
      throw new Error('reason is required');
    }
    const rows = (await this.ds.query(
      `SELECT public.recover_task($1::uuid, $2::public.task_status_enum, $3::varchar(128), $4::text) AS new_lease`,
      [id, targetStatus, `user:${callerUserId}`, trimmedReason],
    )) as Array<{ new_lease: string | number }>;
    const newLease = Number(rows[0]?.new_lease ?? 0);
    return { new_lease: newLease };
  }
}

export interface TaskDetail {
  id: string;
  display_id: string;
  project_id: string;
  project_slug: string;
  github_owner: string;
  github_repo: string;
  report_id: string;
  report_title: string;
  report_body: string;
  module: string;
  risk_tier: string;
  status: string;
  branch_name: string | null;
  plan: string | null;
  approved_base_sha: string | null;
  approved_head_sha: string | null;
  review_decision: string | null;
  review_score: number | null;
  review_model_used: string | null;
  review_notes_md: string | null;
  audit_status: string | null;
  audit_notes_md: string | null;
  github_pr_number: number | null;
  merged_commit_sha: string | null;
  retry_count: number;
  lease_version: number;
  created_at: string;
  completed_at: string | null;
  human_approved_at: string | null;
  failure_reason: string | null;
  feedback?: TaskFeedbackRow[];
  threads?: ThreadRow[];
  attachments?: ReportAttachmentRow[];
  deploy_activity?: DeployActivityRow[];
}

export interface DeployActivityRow {
  id: string;
  action: string;
  issued_at: string;
  apply_started_at: string | null;
  applied_at: string | null;
  applied_status: string | null;
  applied_log_excerpt: string | null;
  deploy_sha: string;
  slot: 'deploy' | 'rollback' | 'other';
}

export interface ReportAttachmentRow {
  id: number;
  name: string;
  mime_type: string;
  size: number;
  content_base64: string;
  created_at: string;
}

export interface TaskFeedbackRow {
  id: number;
  attempt_number: number;
  feedback_text: string;
  files: Array<{ name: string; size: number; content: string }>;
  reported_at: string;
}

export interface ThreadRow {
  id: string;
  author_kind: string;
  author_name: string;
  body: string;
  created_at: string;
}
