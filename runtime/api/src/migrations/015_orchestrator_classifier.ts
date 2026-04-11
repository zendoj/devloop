import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 015 — upgrade orchestrate_task_for_report with
 * classifier parameters + module_locks integration.
 *
 * Fas 2 moves classification from the SQL proc to the TypeScript
 * service layer where it has access to the project_configs JSON
 * rules. The proc now accepts module + risk_tier as required
 * parameters and additionally:
 *
 *   - tries to acquire module_lock via public.acquire_module_lock
 *   - if lock acquired, calls public.fence_and_transition to move
 *     the task from queued_for_lock → assigned in the same txn
 *   - if lock held by another task, leaves the new task in
 *     queued_for_lock for the Worker Manager to retry later
 *
 * This preserves the Fas 1 contract (exactly one task per report,
 * report triaged in the same txn) while eliminating the
 * hardcoded module='unknown'/risk='standard' stubs.
 *
 * Grants unchanged — devloop_api still has EXECUTE on the
 * function and on the downstream fence_and_transition and
 * acquire_module_lock.
 */
export class OrchestratorClassifier1712700000015 implements MigrationInterface {
  name = 'OrchestratorClassifier1712700000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop the old single-arg signature first so CREATE OR REPLACE
    // cannot land both side by side.
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.orchestrate_task_for_report(uuid);
    `);

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

        -- Step 1: row-lock the report so the SAME report cannot be
        -- orchestrated twice.
        SELECT project_id, title
          INTO v_project_id, v_title
          FROM public.reports
         WHERE id = p_report_id
           AND status = 'new'
         FOR UPDATE;

        IF NOT FOUND THEN
          RETURN;
        END IF;

        -- Step 2: per-project advisory lock so concurrent
        -- orchestrations of DIFFERENT reports in the same project
        -- serialize display_id allocation.
        PERFORM pg_advisory_xact_lock(
          hashtext('orchestrate_task_for_report'),
          hashtext(v_project_id::text)
        );

        -- Step 3: next display_id.
        SELECT COALESCE(
          MAX(NULLIF(regexp_replace(display_id, '^T-', ''), '')::bigint),
          0
        ) + 1
          INTO v_seq
          FROM public.agent_tasks
         WHERE project_id = v_project_id
           AND display_id ~ '^T-[0-9]+$';
        v_display_id := 'T-' || v_seq::text;

        -- Step 4: insert the task in queued_for_lock with the
        -- caller-supplied classification.
        INSERT INTO public.agent_tasks (
          project_id, report_id, display_id, agent_name, module,
          risk_tier, status
        ) VALUES (
          v_project_id, p_report_id, v_display_id, 'claude', p_module,
          p_risk_tier,
          'queued_for_lock'::public.task_status_enum
        )
        RETURNING id INTO v_new_task;

        -- Step 5: promote the report to 'triaged' regardless of
        -- lock outcome — the task exists either way.
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

        -- Step 6: try to acquire the module lock. On success, the
        -- return is the module_locks.lease_version (starts at 1);
        -- on NULL, another task is actively holding the lock and
        -- the Worker Manager will retry later.
        v_module_lease := public.acquire_module_lock(
          v_project_id, p_module, v_new_task, 'orchestrator'
        );

        IF v_module_lease IS NOT NULL THEN
          -- Transition queued_for_lock → assigned. The new lease
          -- we pass in is the agent_tasks.lease_version, which
          -- starts at 0 on fresh insert. fence_and_transition
          -- bumps it.
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

    await queryRunner.query(`
      REVOKE ALL ON FUNCTION public.orchestrate_task_for_report(uuid, varchar, public.risk_tier_enum) FROM PUBLIC;
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.orchestrate_task_for_report(uuid, varchar, public.risk_tier_enum) TO devloop_api;
    `);

    // devloop_api needs EXECUTE on acquire_module_lock so the
    // Worker Manager can re-acquire the lock on a blocked task
    // retry path later. The SECURITY DEFINER orchestrator above
    // runs as devloop_owner so it does not need this grant itself.
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.acquire_module_lock(uuid, varchar, uuid, varchar) TO devloop_api;
    `);
    // claim_assigned_task — Worker Manager calls this to pick up
    // an 'assigned' task and atomically mark it in_progress.
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.claim_assigned_task(uuid, varchar, varchar) TO devloop_api;
    `);
    // refresh_task — heartbeat from the running worker. Signature
    // is (task_id, expected_lease, expected_status); no worker_id
    // argument (the existing proc reads the lock holder from the
    // task row).
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.refresh_task(uuid, bigint, public.task_status_enum) TO devloop_api;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.orchestrate_task_for_report(uuid, varchar, public.risk_tier_enum);
    `);
    // Restore the prior 2-arg form from migration 014 so cycles
    // are deterministic.
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
         WHERE id = p_report_id AND status = 'new' FOR UPDATE;
        IF NOT FOUND THEN RETURN NULL; END IF;
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
        UPDATE public.reports SET status='triaged', triaged_at=now()
          WHERE id = p_report_id;
        RETURN v_new_task;
      END;
      $fn$;
    `);
  }
}
