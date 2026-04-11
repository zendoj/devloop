import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 017 — record_review_result helper for Fas 4.
 *
 * The Reviewer service polls tasks in 'review' status, fetches
 * the diff, calls gpt-5.4, and needs to stamp the review outcome
 * onto the task BEFORE calling fence_and_transition. The fields
 * to stamp are: review_decision, review_model_used, review_score,
 * review_attempts (incremented).
 *
 * Same pattern as record_worker_result (Fas 3): keep write
 * authority on agent_tasks narrow by routing through a
 * SECURITY DEFINER helper rather than handing devloop_api a
 * column-level UPDATE grant.
 *
 * The function:
 *   - validates inputs (decision is 'approved' / 'changes_requested',
 *     model name non-empty, score 0..100)
 *   - increments review_attempts atomically
 *   - returns true on success, false if the task moved out of
 *     'review' (cancelled by janitor, etc.)
 *   - emits review_completed audit event with the model + score
 *     in the payload
 *
 * It does NOT change task status — fence_and_transition handles
 * that and the caller is expected to call this function FIRST so
 * the audit log shows the review metadata before the transition.
 */
export class RecordReviewResult1712700000017 implements MigrationInterface {
  name = 'RecordReviewResult1712700000017';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.record_review_result(
        p_task_id     uuid,
        p_decision    public.review_decision_enum,
        p_model       varchar(64),
        p_score       int,
        p_summary     jsonb
      ) RETURNS boolean
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_updated  integer;
        v_project  uuid;
      BEGIN
        IF p_task_id IS NULL THEN
          RAISE EXCEPTION 'record_review_result: task_id required';
        END IF;
        IF p_decision IS NULL THEN
          RAISE EXCEPTION 'record_review_result: decision required';
        END IF;
        IF p_decision NOT IN ('approved', 'changes_requested') THEN
          RAISE EXCEPTION 'record_review_result: decision must be approved or changes_requested (got %)',
            p_decision;
        END IF;
        IF p_model IS NULL OR char_length(btrim(p_model)) = 0 THEN
          RAISE EXCEPTION 'record_review_result: model required';
        END IF;
        IF p_score IS NULL OR p_score < 0 OR p_score > 100 THEN
          RAISE EXCEPTION 'record_review_result: score must be 0..100 (got %)', p_score;
        END IF;
        IF p_summary IS NULL THEN
          RAISE EXCEPTION 'record_review_result: summary jsonb required';
        END IF;

        UPDATE public.agent_tasks
           SET review_decision   = p_decision,
               review_model_used = p_model,
               review_score      = p_score,
               review_attempts   = review_attempts + 1
         WHERE id     = p_task_id
           AND status = 'review'
        RETURNING project_id INTO v_project;

        GET DIAGNOSTICS v_updated = ROW_COUNT;
        IF v_updated = 0 THEN
          RETURN false;
        END IF;

        PERFORM public.append_audit_event(
          v_project, p_task_id, NULL::uuid,
          'review_completed'::public.audit_event_enum,
          'system'::public.actor_kind_enum,
          'reviewer',
          jsonb_build_object(
            'decision', p_decision::text,
            'model',    p_model,
            'score',    p_score,
            'summary',  p_summary
          ),
          NULL::varchar(32), NULL::varchar(32), NULL::varchar(64),
          p_decision::text::varchar(32)
        );
        RETURN true;
      END;
      $fn$;
    `);

    await queryRunner.query(`
      REVOKE ALL ON FUNCTION public.record_review_result(uuid, public.review_decision_enum, varchar, int, jsonb) FROM PUBLIC;
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.record_review_result(uuid, public.review_decision_enum, varchar, int, jsonb) TO devloop_api;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.record_review_result(uuid, public.review_decision_enum, varchar, int, jsonb);
    `);
  }
}
