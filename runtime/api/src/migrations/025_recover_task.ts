import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 025 — recover_task() SQL helper.
 *
 * Adds a SECURITY DEFINER function that atomically:
 *   1. Releases the deploy_mutex for the task's project (if held)
 *   2. Releases the module_lock for the task's (project, module) (if held)
 *   3. Transitions the task status to an operator-chosen target
 *   4. Emits an audit event of type 'lock_fenced' with a recovery note
 *
 * Used by the admin "recover" endpoint when a task is stuck in
 * rollback_failed (or any other dead-end state). The migration 023
 * version of fence_and_transition sets deploy_mutex.expires_at =
 * 'infinity' on rollback_failed per §19 D5 — intentional safety —
 * so recovery requires a separate entry point that the admin UI
 * can call after they've inspected the host and confirmed the
 * state is sane.
 *
 * Legal target statuses: 'ready_for_test', 'assigned', 'failed',
 * 'cancelled'. Any other target is rejected. The caller is
 * expected to use 'ready_for_test' when the code is actually live,
 * 'assigned' to let the worker retry, 'failed' to hard-fail, or
 * 'cancelled' when the task is obsolete.
 *
 * This does NOT go through fence_and_transition — the legal
 * transition table would reject most of these. Instead it does a
 * direct UPDATE with a lease bump and logs an audit trail.
 */
export class RecoverTask1712700000025 implements MigrationInterface {
  name = 'RecoverTask1712700000025';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.recover_task(
        p_task_id      uuid,
        p_target       public.task_status_enum,
        p_actor_name   varchar(128),
        p_reason       text
      ) RETURNS bigint
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_task       record;
        v_new_lease  bigint;
      BEGIN
        IF p_task_id IS NULL OR p_target IS NULL OR p_actor_name IS NULL
           OR char_length(p_actor_name) = 0 THEN
          RAISE EXCEPTION 'recover_task: all arguments required and non-empty';
        END IF;

        -- Guardrail: only a small set of targets are legal. This
        -- prevents an admin UI bug from walking a task into e.g.
        -- 'deploying' which requires a deploy_mutex acquisition.
        IF p_target NOT IN (
          'ready_for_test'::public.task_status_enum,
          'assigned'::public.task_status_enum,
          'failed'::public.task_status_enum,
          'cancelled'::public.task_status_enum
        ) THEN
          RAISE EXCEPTION
            'recover_task: illegal target status % (allowed: ready_for_test, assigned, failed, cancelled)',
            p_target;
        END IF;

        SELECT id, project_id, report_id, module, status, lease_version
          INTO v_task
          FROM public.agent_tasks
         WHERE id = p_task_id
         FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'recover_task: task % not found', p_task_id;
        END IF;

        -- Release deploy_mutex if the task holds it. We match by
        -- holder_task_id so we only clear rows we own. The WHERE
        -- keeps us from blowing away a live mutex that some other
        -- task happens to hold on the same project right now.
        UPDATE public.deploy_mutex
           SET holder_task_id    = NULL,
               holder_worker_id  = NULL,
               acquired_at       = NULL,
               last_heartbeat_at = NULL,
               expires_at        = NULL,
               lease_version     = public.deploy_mutex.lease_version + 1
         WHERE project_id     = v_task.project_id
           AND holder_task_id = p_task_id;

        -- Release module_lock if the task holds it. Same rule.
        UPDATE public.module_locks
           SET holder_task_id    = NULL,
               holder_worker_id  = NULL,
               acquired_at       = NULL,
               last_heartbeat_at = NULL,
               expires_at        = NULL,
               lease_version     = public.module_locks.lease_version + 1
         WHERE project_id     = v_task.project_id
           AND module         = v_task.module
           AND holder_task_id = p_task_id;

        -- Update the task row. We bump lease_version to invalidate
        -- any worker still hanging on to the old one. completed_at
        -- is set on terminal targets (failed/cancelled) and cleared
        -- on retry targets (assigned/ready_for_test) so the UI can
        -- decide what "still open" means.
        UPDATE public.agent_tasks
           SET status         = p_target,
               lease_version  = public.agent_tasks.lease_version + 1,
               failure_reason = COALESCE(
                 'recovered from ' || v_task.status::text || ': ' || p_reason,
                 'recovered from ' || v_task.status::text
               ),
               completed_at   = CASE
                 WHEN p_target IN (
                   'failed'::public.task_status_enum,
                   'cancelled'::public.task_status_enum
                 ) THEN now()
                 ELSE NULL
               END
         WHERE id = p_task_id
         RETURNING lease_version INTO v_new_lease;

        -- Audit trail. Reuses the existing append_audit_event
        -- helper from migration 005 — same shape as fence_and_transition.
        INSERT INTO public.audit_events (
          project_id, task_id, report_id, event_type, actor_kind,
          actor_name, event_details, approved_by_admin_role,
          approved_by_agent_id, approved_by_worker_id, approved_by_role
        ) VALUES (
          v_task.project_id, p_task_id, v_task.report_id,
          'lock_fenced'::public.audit_event_enum,
          'user'::public.actor_kind_enum,
          p_actor_name,
          jsonb_build_object(
            'action',          'recover_task',
            'from_status',     v_task.status::text,
            'to_status',       p_target::text,
            'reason',          p_reason,
            'released_mutex',  true,
            'released_lock',   true,
            'new_lease',       v_new_lease
          ),
          NULL::varchar(32), NULL::varchar(32), NULL::varchar(64), NULL::varchar(32)
        );

        RETURN v_new_lease;
      END;
      $fn$;
    `);

    await queryRunner.query(`
      REVOKE ALL ON FUNCTION public.recover_task(uuid, public.task_status_enum, varchar, text) FROM PUBLIC;
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.recover_task(uuid, public.task_status_enum, varchar, text) TO devloop_api;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.recover_task(uuid, public.task_status_enum, varchar, text);
    `);
  }
}
