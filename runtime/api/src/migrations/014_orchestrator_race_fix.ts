import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 014 — fix orchestrate_task_for_report per-project race.
 *
 * Round-1 Fas 1 review from gpt-5.4 flagged that
 * orchestrate_task_for_report locks only the report row, which is
 * enough to block double-orchestration of the SAME report but NOT
 * enough to serialize concurrent orchestration of DIFFERENT reports
 * in the SAME project. Two concurrent callers could therefore read
 * the same MAX(display_id) and both mint T-N+1.
 *
 * Fix: two independent guarantees.
 *   1. Add a UNIQUE index on (project_id, display_id) so a race
 *      cannot land two rows with the same display_id even if the
 *      lock fails.
 *   2. Take a per-project transaction-scoped advisory lock inside
 *      orchestrate_task_for_report via pg_advisory_xact_lock in
 *      the (int, int) form with a class key derived from the
 *      function name, so concurrent callers serialize on this
 *      project's orchestration. Matches the pattern used in
 *      record_desired_state and record_host_health_probe.
 *
 * Also tightens the display_id sequence computation to use a
 * simple LEFT JOIN on the subquery result, but the critical
 * change is the lock.
 */
export class OrchestratorRaceFix1712700000014 implements MigrationInterface {
  name = 'OrchestratorRaceFix1712700000014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_agent_tasks_display_id_per_project
        ON public.agent_tasks(project_id, display_id);
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.orchestrate_task_for_report(
        p_report_id uuid
      ) RETURNS uuid
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_project_id uuid;
        v_title      varchar(200);
        v_new_task   uuid;
        v_display_id varchar(64);
        v_seq        bigint;
      BEGIN
        IF p_report_id IS NULL THEN
          RAISE EXCEPTION 'orchestrate_task_for_report: report_id required';
        END IF;

        -- Step 1: row-lock the report so the SAME report cannot be
        -- orchestrated twice.
        SELECT project_id, title
          INTO v_project_id, v_title
          FROM public.reports
         WHERE id = p_report_id
           AND status = 'new'
         FOR UPDATE;

        IF NOT FOUND THEN
          RETURN NULL;
        END IF;

        -- Step 2: take a per-project transaction-scoped advisory
        -- lock so concurrent orchestration of DIFFERENT reports
        -- within the same project is also serialized. Without
        -- this, two callers could read the same MAX(display_id)
        -- and both mint T-N+1. The (int, int) form namespaces
        -- the lock with a class key derived from the function
        -- name so we do not collide with unrelated callers that
        -- may hash project_id for their own purposes. Released
        -- automatically on COMMIT/ROLLBACK. The UNIQUE index on
        -- (project_id, display_id) is the hard backstop.
        PERFORM pg_advisory_xact_lock(
          hashtext('orchestrate_task_for_report'),
          hashtext(v_project_id::text)
        );

        SELECT COALESCE(
          MAX(NULLIF(regexp_replace(display_id, '^T-', ''), '')::bigint),
          0
        ) + 1
          INTO v_seq
          FROM public.agent_tasks
         WHERE project_id = v_project_id
           AND display_id ~ '^T-[0-9]+$';
        v_display_id := 'T-' || v_seq::text;

        INSERT INTO public.agent_tasks (
          project_id, report_id, display_id, agent_name, module,
          risk_tier, status
        ) VALUES (
          v_project_id, p_report_id, v_display_id, 'claude', 'unknown',
          'standard'::public.risk_tier_enum,
          'queued_for_lock'::public.task_status_enum
        )
        RETURNING id INTO v_new_task;

        UPDATE public.reports
           SET status = 'triaged',
               triaged_at = now()
         WHERE id = p_report_id;

        PERFORM public.append_audit_event(
          v_project_id, v_new_task, p_report_id,
          'task_created'::public.audit_event_enum,
          'system'::public.actor_kind_enum,
          'orchestrator-stub',
          jsonb_build_object(
            'report_id',  p_report_id,
            'display_id', v_display_id,
            'title',      v_title,
            'module',     'unknown',
            'risk_tier',  'standard'
          ),
          NULL::varchar(32), 'queued_for_lock'::varchar(32),
          NULL::varchar(64), NULL::varchar(32)
        );
        PERFORM public.append_audit_event(
          v_project_id, NULL::uuid, p_report_id,
          'report_triaged'::public.audit_event_enum,
          'system'::public.actor_kind_enum,
          'orchestrator-stub',
          jsonb_build_object(
            'report_id',   p_report_id,
            'new_task_id', v_new_task
          ),
          'new'::varchar(32), 'triaged'::varchar(32),
          NULL::varchar(64), NULL::varchar(32)
        );

        RETURN v_new_task;
      END;
      $fn$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS public.idx_agent_tasks_display_id_per_project;
    `);
    // Restore the race-prone version (from migration 012) so down+up
    // cycles are deterministic. Callers SHOULD NOT actually run this
    // down — it re-introduces the known bug.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.orchestrate_task_for_report(
        p_report_id uuid
      ) RETURNS uuid
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_project_id uuid;
        v_title      varchar(200);
        v_new_task   uuid;
        v_display_id varchar(64);
        v_seq        bigint;
      BEGIN
        IF p_report_id IS NULL THEN
          RAISE EXCEPTION 'orchestrate_task_for_report: report_id required';
        END IF;
        SELECT project_id, title
          INTO v_project_id, v_title
          FROM public.reports
         WHERE id = p_report_id
           AND status = 'new'
         FOR UPDATE;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT COALESCE(
          MAX(NULLIF(regexp_replace(display_id, '^T-', ''), '')::bigint),
          0
        ) + 1
          INTO v_seq
          FROM public.agent_tasks
         WHERE project_id = v_project_id
           AND display_id ~ '^T-[0-9]+$';
        v_display_id := 'T-' || v_seq::text;
        INSERT INTO public.agent_tasks (
          project_id, report_id, display_id, agent_name, module,
          risk_tier, status
        ) VALUES (
          v_project_id, p_report_id, v_display_id, 'claude', 'unknown',
          'standard'::public.risk_tier_enum,
          'queued_for_lock'::public.task_status_enum
        )
        RETURNING id INTO v_new_task;
        UPDATE public.reports
           SET status = 'triaged', triaged_at = now()
         WHERE id = p_report_id;
        RETURN v_new_task;
      END;
      $fn$;
    `);
  }
}
