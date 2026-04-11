import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 018 — fix the reviewer race flagged by gpt-5.4
 * Fas 2-5 review round 1 (critical).
 *
 * The Fas 4 reviewer polls 'review' tasks with no claim primitive.
 * The original record_review_result accepted any 'review' row,
 * which meant two reviewer instances could both stamp metadata
 * before either of them tried to fence_and_transition. The first
 * one to fence wins, leaving the loser's decision/score on the
 * row but the status flipped by the winner — an inconsistent
 * state where status='approved' could carry
 * review_decision='changes_requested'.
 *
 * Fix: lease-fence record_review_result. New signature takes
 * p_expected_lease and requires lease_version match in addition
 * to status='review' AND review_decision IS NULL. The first
 * concurrent caller wins; the second sees zero rows updated and
 * returns false (the reviewer then aborts cleanly without
 * fence_and_transition'ing).
 */
export class ReviewLeaseFence1712700000018 implements MigrationInterface {
  name = 'ReviewLeaseFence1712700000018';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop the unfenced version first.
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.record_review_result(uuid, public.review_decision_enum, varchar, int, jsonb);
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.record_review_result(
        p_task_id        uuid,
        p_expected_lease bigint,
        p_decision       public.review_decision_enum,
        p_model          varchar(64),
        p_score          int,
        p_summary        jsonb
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
        IF p_expected_lease IS NULL THEN
          RAISE EXCEPTION 'record_review_result: expected_lease required';
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
        IF jsonb_typeof(p_summary) <> 'object' THEN
          RAISE EXCEPTION 'record_review_result: summary must be a jsonb object';
        END IF;

        -- Lease-fenced: require both status='review' AND
        -- lease_version = expected AND review_decision IS NULL.
        -- The first concurrent reviewer wins; subsequent callers
        -- see zero rows and return false.
        UPDATE public.agent_tasks
           SET review_decision   = p_decision,
               review_model_used = p_model,
               review_score      = p_score,
               review_attempts   = review_attempts + 1
         WHERE id              = p_task_id
           AND status          = 'review'
           AND lease_version   = p_expected_lease
           AND review_decision IS NULL
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
      REVOKE ALL ON FUNCTION public.record_review_result(uuid, bigint, public.review_decision_enum, varchar, int, jsonb) FROM PUBLIC;
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.record_review_result(uuid, bigint, public.review_decision_enum, varchar, int, jsonb) TO devloop_api;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.record_review_result(uuid, bigint, public.review_decision_enum, varchar, int, jsonb);
    `);
    // Restore the prior unfenced signature from migration 017
    // so down + up cycles are deterministic. The restored
    // function reintroduces the known race; only run down() in
    // testing, never in production rollback after a real Fas 4
    // run.
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
          RAISE EXCEPTION 'record_review_result: decision must be approved or changes_requested';
        END IF;
        IF p_model IS NULL OR char_length(btrim(p_model)) = 0 THEN
          RAISE EXCEPTION 'record_review_result: model required';
        END IF;
        IF p_score IS NULL OR p_score < 0 OR p_score > 100 THEN
          RAISE EXCEPTION 'record_review_result: score must be 0..100';
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
        IF v_updated = 0 THEN RETURN false; END IF;
        PERFORM public.append_audit_event(
          v_project, p_task_id, NULL::uuid,
          'review_completed'::public.audit_event_enum,
          'system'::public.actor_kind_enum,
          'reviewer',
          jsonb_build_object('decision', p_decision::text, 'model', p_model, 'score', p_score),
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
}
