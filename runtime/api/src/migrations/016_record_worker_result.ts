import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 016 — record_worker_result helper for Fas 3.
 *
 * After the worker runtime clones a project, makes its diff,
 * commits, and pushes a devloop/task/T-N branch, the Worker
 * Manager needs to stamp the diff metadata onto the agent_tasks
 * row: branch_name, approved_base_sha, approved_head_sha,
 * files_changed.
 *
 * Granting devloop_api a column-level UPDATE on each of those
 * fields would work but spreads write authority across the
 * runtime path. A small SECURITY DEFINER function keeps the
 * write capability narrow:
 *
 *   - validates that the task exists and is currently in_progress
 *     (the only state where worker output is meaningful — if
 *     the row has already been cancelled or failed by the
 *     janitor, the worker stamping should be a no-op rather than
 *     overwriting state)
 *   - SHA fields are checked for plausible length (40 hex chars
 *     for git, but bounded loosely so a longer hash format does
 *     not break the function)
 *   - branch name must be non-empty
 *   - files_changed is taken as jsonb so the same shape can
 *     hold a richer payload later (per-file diff stats etc.)
 *
 * The function intentionally does NOT change task status — that
 * is fence_and_transition's job. The Worker Manager calls this
 * function FIRST and then transitions to 'review' so the
 * reviewer always sees the diff metadata when it picks the task
 * up.
 */
export class RecordWorkerResult1712700000016 implements MigrationInterface {
  name = 'RecordWorkerResult1712700000016';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.record_worker_result(
        p_task_id      uuid,
        p_branch_name  varchar(255),
        p_base_sha     varchar(64),
        p_head_sha     varchar(64),
        p_files_changed jsonb
      ) RETURNS boolean
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_updated integer;
        v_project_id uuid;
      BEGIN
        IF p_task_id IS NULL THEN
          RAISE EXCEPTION 'record_worker_result: task_id required';
        END IF;
        IF p_branch_name IS NULL OR char_length(btrim(p_branch_name)) = 0 THEN
          RAISE EXCEPTION 'record_worker_result: branch_name required';
        END IF;
        IF p_base_sha IS NULL OR char_length(btrim(p_base_sha)) < 7
           OR char_length(p_base_sha) > 64 THEN
          RAISE EXCEPTION 'record_worker_result: base_sha must be 7..64 chars';
        END IF;
        IF p_head_sha IS NULL OR char_length(btrim(p_head_sha)) < 7
           OR char_length(p_head_sha) > 64 THEN
          RAISE EXCEPTION 'record_worker_result: head_sha must be 7..64 chars';
        END IF;
        IF p_files_changed IS NULL THEN
          RAISE EXCEPTION 'record_worker_result: files_changed required (use ''[]''::jsonb for none)';
        END IF;

        -- Only stamp metadata while the task is still in_progress.
        -- A janitor that cancelled the task in parallel must win.
        UPDATE public.agent_tasks
           SET branch_name        = p_branch_name,
               approved_base_sha  = p_base_sha,
               approved_head_sha  = p_head_sha,
               files_changed      = p_files_changed
         WHERE id     = p_task_id
           AND status = 'in_progress'
        RETURNING project_id INTO v_project_id;

        GET DIAGNOSTICS v_updated = ROW_COUNT;
        IF v_updated = 0 THEN
          RETURN false;
        END IF;

        PERFORM public.append_audit_event(
          v_project_id, p_task_id, NULL::uuid,
          'worker_exited'::public.audit_event_enum,
          'system'::public.actor_kind_enum,
          'worker-runtime',
          jsonb_build_object(
            'branch',     p_branch_name,
            'base_sha',   p_base_sha,
            'head_sha',   p_head_sha,
            'files_changed', p_files_changed
          ),
          NULL::varchar(32), NULL::varchar(32),
          p_head_sha::varchar(64), NULL::varchar(32)
        );
        RETURN true;
      END;
      $fn$;
    `);

    await queryRunner.query(`
      REVOKE ALL ON FUNCTION public.record_worker_result(uuid, varchar, varchar, varchar, jsonb) FROM PUBLIC;
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.record_worker_result(uuid, varchar, varchar, varchar, jsonb) TO devloop_api;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.record_worker_result(uuid, varchar, varchar, varchar, jsonb);
    `);
  }
}
