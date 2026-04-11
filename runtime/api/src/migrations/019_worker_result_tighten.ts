import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 019 — tighten record_worker_result validation per
 * Fas 2-5 round 2 review.
 *
 * Changes:
 *   - Require p_files_changed to be a jsonb ARRAY (not just
 *     non-null). The runtime always sends an array; enforcing
 *     it at the helper boundary keeps the schema honest.
 *   - Require p_base_sha and p_head_sha to be lowercase
 *     hexadecimal strings (a-f0-9) of plausible length.
 *     length-only checking previously let any garbage through.
 *   - Require p_branch_name to match a sane charset to avoid
 *     log-forging or arg injection if the branch name ever
 *     ends up in a shell elsewhere.
 *
 * Same SECURITY DEFINER posture, same grant target. The new
 * function CREATE OR REPLACE keeps the same signature so the
 * Worker Manager call site does not change.
 */
export class WorkerResultTighten1712700000019 implements MigrationInterface {
  name = 'WorkerResultTighten1712700000019';

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
        -- Branch name charset: lowercase letters, digits, /._-
        -- This bans whitespace, shell metacharacters, and unicode.
        IF p_branch_name !~ '^[a-z0-9/._-]{1,255}$' THEN
          RAISE EXCEPTION 'record_worker_result: branch_name has invalid characters';
        END IF;
        -- Hex SHA: lowercase 0-9 a-f, length 7..64.
        IF p_base_sha IS NULL OR p_base_sha !~ '^[0-9a-f]{7,64}$' THEN
          RAISE EXCEPTION 'record_worker_result: base_sha must be lowercase hex 7..64 chars';
        END IF;
        IF p_head_sha IS NULL OR p_head_sha !~ '^[0-9a-f]{7,64}$' THEN
          RAISE EXCEPTION 'record_worker_result: head_sha must be lowercase hex 7..64 chars';
        END IF;
        IF p_files_changed IS NULL THEN
          RAISE EXCEPTION 'record_worker_result: files_changed required (use ''[]''::jsonb for none)';
        END IF;
        IF jsonb_typeof(p_files_changed) <> 'array' THEN
          RAISE EXCEPTION 'record_worker_result: files_changed must be a jsonb array';
        END IF;

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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the prior (looser) validation from migration 016.
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
        IF p_base_sha IS NULL OR char_length(btrim(p_base_sha)) < 7 OR char_length(p_base_sha) > 64 THEN
          RAISE EXCEPTION 'record_worker_result: base_sha must be 7..64 chars';
        END IF;
        IF p_head_sha IS NULL OR char_length(btrim(p_head_sha)) < 7 OR char_length(p_head_sha) > 64 THEN
          RAISE EXCEPTION 'record_worker_result: head_sha must be 7..64 chars';
        END IF;
        IF p_files_changed IS NULL THEN
          RAISE EXCEPTION 'record_worker_result: files_changed required';
        END IF;
        UPDATE public.agent_tasks
           SET branch_name        = p_branch_name,
               approved_base_sha  = p_base_sha,
               approved_head_sha  = p_head_sha,
               files_changed      = p_files_changed
         WHERE id     = p_task_id
           AND status = 'in_progress'
        RETURNING project_id INTO v_project_id;
        GET DIAGNOSTICS v_updated = ROW_COUNT;
        IF v_updated = 0 THEN RETURN false; END IF;
        PERFORM public.append_audit_event(
          v_project_id, p_task_id, NULL::uuid,
          'worker_exited'::public.audit_event_enum,
          'system'::public.actor_kind_enum,
          'worker-runtime',
          jsonb_build_object('branch', p_branch_name, 'base_sha', p_base_sha, 'head_sha', p_head_sha, 'files_changed', p_files_changed),
          NULL::varchar(32), NULL::varchar(32), p_head_sha::varchar(64), NULL::varchar(32)
        );
        RETURN true;
      END;
      $fn$;
    `);
  }
}
