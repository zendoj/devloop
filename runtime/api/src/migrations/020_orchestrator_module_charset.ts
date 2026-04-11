import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 020 — DB-side module charset validation in
 * orchestrate_task_for_report.
 *
 * Per Fas 2-5 round 6 suggestion. The ClassifierService at
 * the app layer already validates module names against
 * ^[a-z0-9][a-z0-9/._-]*$, but the SQL proc accepted any
 * non-empty varchar(64). Since module flows into
 * module_locks.module (the lock key for cross-task
 * concurrency), server-side enforcement makes the lock
 * namespace authoritative at the DB boundary regardless of
 * which caller invokes the proc.
 *
 * Only the validation block changes; the rest of the function
 * body is identical to migration 015.
 */
export class OrchestratorModuleCharset1712700000020 implements MigrationInterface {
  name = 'OrchestratorModuleCharset1712700000020';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.orchestrate_task_for_report(
        p_report_id uuid,
        p_module    varchar(64),
        p_risk_tier public.risk_tier_enum
      ) RETURNS TABLE (
        out_task_id    uuid,
        out_display_id varchar(64),
        out_status     public.task_status_enum
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_project_id   uuid;
        v_title        varchar(200);
        v_new_task     uuid;
        v_display_id   varchar(64);
        v_seq          bigint;
        v_module_lease bigint;
        v_new_lease    bigint;
        v_final_status public.task_status_enum;
      BEGIN
        IF p_report_id IS NULL THEN
          RAISE EXCEPTION 'orchestrate_task_for_report: report_id required';
        END IF;
        IF p_module IS NULL OR char_length(btrim(p_module)) = 0 THEN
          RAISE EXCEPTION 'orchestrate_task_for_report: module required';
        END IF;
        -- Module is the module_locks.module lock key. Require the
        -- same charset the classifier and worker runtime enforce
        -- so the lock namespace is authoritative at the DB
        -- boundary regardless of which caller invokes the proc.
        -- Lowercase alpha + digits + safe path-ish punctuation,
        -- must start with alpha/digit.
        IF p_module !~ '^[a-z0-9][a-z0-9/._-]*$' THEN
          RAISE EXCEPTION 'orchestrate_task_for_report: module must match ^[a-z0-9][a-z0-9/._-]*$ (got %)', p_module;
        END IF;
        IF char_length(p_module) > 64 THEN
          RAISE EXCEPTION 'orchestrate_task_for_report: module max 64 chars';
        END IF;
        IF p_risk_tier IS NULL THEN
          RAISE EXCEPTION 'orchestrate_task_for_report: risk_tier required';
        END IF;

        SELECT project_id, title
          INTO v_project_id, v_title
          FROM public.reports
         WHERE id = p_report_id
           AND status = 'new'
         FOR UPDATE;

        IF NOT FOUND THEN
          RETURN;
        END IF;

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
          v_project_id, p_report_id, v_display_id, 'claude', p_module,
          p_risk_tier,
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
          'orchestrator',
          jsonb_build_object(
            'report_id',  p_report_id,
            'display_id', v_display_id,
            'title',      v_title,
            'module',     p_module,
            'risk_tier',  p_risk_tier::text
          ),
          NULL::varchar(32), 'queued_for_lock'::varchar(32),
          NULL::varchar(64), NULL::varchar(32)
        );
        PERFORM public.append_audit_event(
          v_project_id, NULL::uuid, p_report_id,
          'report_triaged'::public.audit_event_enum,
          'system'::public.actor_kind_enum,
          'orchestrator',
          jsonb_build_object(
            'report_id',   p_report_id,
            'new_task_id', v_new_task,
            'module',      p_module
          ),
          'new'::varchar(32), 'triaged'::varchar(32),
          NULL::varchar(64), NULL::varchar(32)
        );

        v_module_lease := public.acquire_module_lock(
          v_project_id, p_module, v_new_task, 'orchestrator'
        );

        IF v_module_lease IS NOT NULL THEN
          v_new_lease := public.fence_and_transition(
            v_new_task,
            0::bigint,
            'queued_for_lock'::public.task_status_enum,
            'assigned'::public.task_status_enum,
            'orchestrator'::varchar(128),
            'system'::public.actor_kind_enum,
            jsonb_build_object('module_lease', v_module_lease),
            NULL::varchar(128)
          );
          v_final_status := 'assigned'::public.task_status_enum;
        ELSE
          v_final_status := 'queued_for_lock'::public.task_status_enum;
        END IF;

        out_task_id    := v_new_task;
        out_display_id := v_display_id;
        out_status     := v_final_status;
        RETURN NEXT;
      END;
      $fn$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Re-running migration 015's body drops the module charset
    // check. CREATE OR REPLACE keeps the same signature.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.orchestrate_task_for_report(
        p_report_id uuid,
        p_module    varchar(64),
        p_risk_tier public.risk_tier_enum
      ) RETURNS TABLE (
        out_task_id    uuid,
        out_display_id varchar(64),
        out_status     public.task_status_enum
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_project_id   uuid;
        v_title        varchar(200);
        v_new_task     uuid;
        v_display_id   varchar(64);
        v_seq          bigint;
        v_module_lease bigint;
        v_new_lease    bigint;
        v_final_status public.task_status_enum;
      BEGIN
        IF p_report_id IS NULL THEN
          RAISE EXCEPTION 'orchestrate_task_for_report: report_id required';
        END IF;
        IF p_module IS NULL OR char_length(btrim(p_module)) = 0 THEN
          RAISE EXCEPTION 'orchestrate_task_for_report: module required';
        END IF;
        IF p_risk_tier IS NULL THEN
          RAISE EXCEPTION 'orchestrate_task_for_report: risk_tier required';
        END IF;
        SELECT project_id, title
          INTO v_project_id, v_title
          FROM public.reports
         WHERE id = p_report_id AND status = 'new' FOR UPDATE;
        IF NOT FOUND THEN RETURN; END IF;
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
         WHERE project_id = v_project_id AND display_id ~ '^T-[0-9]+$';
        v_display_id := 'T-' || v_seq::text;
        INSERT INTO public.agent_tasks (
          project_id, report_id, display_id, agent_name, module,
          risk_tier, status
        ) VALUES (
          v_project_id, p_report_id, v_display_id, 'claude', p_module,
          p_risk_tier, 'queued_for_lock'::public.task_status_enum
        ) RETURNING id INTO v_new_task;
        UPDATE public.reports SET status='triaged', triaged_at=now()
          WHERE id = p_report_id;
        v_module_lease := public.acquire_module_lock(v_project_id, p_module, v_new_task, 'orchestrator');
        IF v_module_lease IS NOT NULL THEN
          v_new_lease := public.fence_and_transition(
            v_new_task, 0::bigint,
            'queued_for_lock'::public.task_status_enum,
            'assigned'::public.task_status_enum,
            'orchestrator'::varchar(128), 'system'::public.actor_kind_enum,
            jsonb_build_object('module_lease', v_module_lease),
            NULL::varchar(128)
          );
          v_final_status := 'assigned'::public.task_status_enum;
        ELSE
          v_final_status := 'queued_for_lock'::public.task_status_enum;
        END IF;
        out_task_id := v_new_task;
        out_display_id := v_display_id;
        out_status := v_final_status;
        RETURN NEXT;
      END;
      $fn$;
    `);
  }
}
