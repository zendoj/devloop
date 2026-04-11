import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 023 — ready_for_test + human feedback loop + agent
 * output storage.
 *
 * Enum values are added in migration 022 (separate transaction
 * because Postgres refuses to reference a new enum value in the
 * same transaction it was added).
 *
 * Adds the human-acceptance-test stage at the end of the pipeline.
 * After the host agent applies a deploy successfully, the task
 * now lands in 'ready_for_test' and waits for Jonas to try the
 * change in the running CRM. Two outcomes:
 *   - accepted  (terminal) — human approved
 *   - assigned  (loop)     — human rejected with feedback; Claude
 *                            runs again with the feedback files
 *
 * Additions:
 *   1. agent_tasks columns:
 *        - human_approved_at    timestamptz
 *        - human_approved_by    uuid references users(id)
 *        - review_notes_md      text       — reviewer prose
 *        - audit_notes_md       text       — security auditor prose
 *        - audit_status         varchar    — clean / warnings / blocking
 *   2. task_feedback table: one row per human rejection,
 *        with text + jsonb files[] array.
 *   3. fence_and_transition updates: new valid transitions for
 *        verifying → ready_for_test
 *        ready_for_test → accepted   (terminal)
 *        ready_for_test → assigned   (human reject, lock retained,
 *                                     retry_count incremented, NO cap)
 */
export class ReadyForTestAndFeedback1712700000023
  implements MigrationInterface
{
  name = 'ReadyForTestAndFeedback1712700000023';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE public.agent_tasks
        ADD COLUMN IF NOT EXISTS human_approved_at timestamptz,
        ADD COLUMN IF NOT EXISTS human_approved_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS review_notes_md text,
        ADD COLUMN IF NOT EXISTS audit_notes_md text,
        ADD COLUMN IF NOT EXISTS audit_status varchar(32)
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.task_feedback (
        id               bigserial PRIMARY KEY,
        task_id          uuid NOT NULL REFERENCES public.agent_tasks(id) ON DELETE CASCADE,
        attempt_number   int NOT NULL,
        reported_by      uuid REFERENCES public.users(id) ON DELETE SET NULL,
        feedback_text    text NOT NULL,
        files            jsonb NOT NULL DEFAULT '[]'::jsonb,
        reported_at      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_task_feedback_task_attempt
        ON public.task_feedback (task_id, attempt_number)
    `);

    // Rewrite fence_and_transition's CASE block to accept the new
    // transitions. The simplest path is a CREATE OR REPLACE that
    // copies the entire function body from migration 018 and adds
    // new branches. We store the full body here.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.fence_and_transition(
        p_task_id         uuid,
        p_expected_lease  bigint,
        p_from_status     public.task_status_enum,
        p_to_status       public.task_status_enum,
        p_actor_name      varchar(128),
        p_actor_kind      public.actor_kind_enum DEFAULT 'agent',
        p_payload         jsonb DEFAULT '{}'::jsonb,
        p_worker_id       varchar(128) DEFAULT NULL
      ) RETURNS bigint
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        MAX_RETRIES CONSTANT int := 3;

        v_current         public.agent_tasks%ROWTYPE;
        v_new_status      public.task_status_enum := p_to_status;
        v_new_retry       int;
        v_forced_blocked  boolean := false;
        v_new_lease       bigint;
        v_releases_lock   boolean := false;
        v_releases_mutex  boolean := false;
        v_clears_worker   boolean := false;
        v_increments_retry boolean := false;
        v_needs_completed boolean := false;
        v_sets_deploying  boolean := false;
        v_mutex_lease     bigint;
        v_failure_reason  text;
        v_audit_event     public.audit_event_enum := 'task_status_changed';
        v_audit_details   jsonb;
        v_cap_retries     boolean := true;
      BEGIN
        IF p_task_id IS NULL OR p_expected_lease IS NULL
           OR p_from_status IS NULL OR p_to_status IS NULL
           OR p_actor_name IS NULL OR char_length(p_actor_name) = 0 THEN
          RAISE EXCEPTION 'fence_and_transition: required arguments missing or empty';
        END IF;

        p_payload := COALESCE(p_payload, '{}'::jsonb);

        SELECT * INTO v_current FROM public.agent_tasks
         WHERE id = p_task_id FOR UPDATE;

        IF v_current.id IS NULL THEN
          RAISE EXCEPTION 'fence_and_transition: task % not found', p_task_id;
        END IF;

        IF v_current.status <> p_from_status THEN
          RAISE EXCEPTION 'fence_and_transition: status mismatch (expected %, actual %)',
            p_from_status, v_current.status;
        END IF;
        IF v_current.lease_version <> p_expected_lease THEN
          RAISE EXCEPTION 'fence_and_transition: lease mismatch (expected %, actual %) — stale caller',
            p_expected_lease, v_current.lease_version;
        END IF;

        CASE
          WHEN p_from_status = 'queued_for_lock' AND p_to_status = 'assigned' THEN NULL;
          WHEN p_from_status = 'queued_for_lock' AND p_to_status = 'cancelled' THEN
            v_needs_completed := true;

          WHEN p_from_status = 'assigned' AND p_to_status = 'cancelled' THEN
            v_releases_lock := true; v_needs_completed := true;
          WHEN p_from_status = 'assigned' AND p_to_status = 'failed' THEN
            v_releases_lock := true; v_needs_completed := true;
          WHEN p_from_status = 'assigned' AND p_to_status = 'blocked' THEN
            v_releases_lock := true; v_clears_worker := true;

          WHEN p_from_status = 'in_progress' AND p_to_status = 'review' THEN NULL;
          WHEN p_from_status = 'in_progress' AND p_to_status = 'blocked' THEN
            v_releases_lock := true; v_clears_worker := true;
          WHEN p_from_status = 'in_progress' AND p_to_status = 'failed' THEN
            v_releases_lock := true; v_needs_completed := true;
          WHEN p_from_status = 'in_progress' AND p_to_status = 'cancelled' THEN
            v_releases_lock := true; v_needs_completed := true;

          WHEN p_from_status = 'review' AND p_to_status = 'approved' THEN NULL;
          WHEN p_from_status = 'review' AND p_to_status = 'changes_requested' THEN NULL;
          WHEN p_from_status = 'review' AND p_to_status = 'blocked' THEN
            v_releases_lock := true; v_clears_worker := true;
          WHEN p_from_status = 'review' AND p_to_status = 'cancelled' THEN
            v_releases_lock := true; v_needs_completed := true;

          WHEN p_from_status = 'changes_requested' AND p_to_status = 'assigned' THEN
            v_clears_worker := true;
            v_increments_retry := true;
          WHEN p_from_status = 'changes_requested' AND p_to_status = 'cancelled' THEN
            v_releases_lock := true; v_needs_completed := true;

          WHEN p_from_status = 'approved' AND p_to_status = 'deploying' THEN
            IF p_worker_id IS NULL OR char_length(p_worker_id) = 0 THEN
              RAISE EXCEPTION 'fence_and_transition: approved → deploying requires p_worker_id';
            END IF;
            v_sets_deploying := true;
          WHEN p_from_status = 'approved' AND p_to_status = 'cancelled' THEN
            v_releases_lock := true; v_needs_completed := true;

          WHEN p_from_status = 'deploying' AND p_to_status = 'merged' THEN NULL;
          WHEN p_from_status = 'deploying' AND p_to_status = 'review' THEN
            v_releases_mutex := true;
          WHEN p_from_status = 'deploying' AND p_to_status = 'failed' THEN
            v_releases_lock := true; v_releases_mutex := true; v_needs_completed := true;

          WHEN p_from_status = 'merged' AND p_to_status = 'verifying' THEN NULL;
          WHEN p_from_status = 'merged' AND p_to_status = 'failed' THEN
            v_releases_lock := true; v_releases_mutex := true; v_needs_completed := true;

          -- OLD: verifying → verified (kept for backwards compat)
          WHEN p_from_status = 'verifying' AND p_to_status = 'verified' THEN
            v_releases_lock := true; v_releases_mutex := true; v_needs_completed := true;
            v_audit_event := 'deploy_verified';

          -- NEW (Fas H): verifying → ready_for_test (post-deploy,
          -- awaiting human acceptance test in the real product).
          -- Lock + mutex RELEASED here so other tasks for the same
          -- module/project can proceed while Jonas tests. The task
          -- is effectively "done from the pipeline's perspective" —
          -- the human gate is out-of-band.
          WHEN p_from_status = 'verifying' AND p_to_status = 'ready_for_test' THEN
            v_releases_lock := true; v_releases_mutex := true;
            v_audit_event := 'task_status_changed';

          WHEN p_from_status = 'verifying' AND p_to_status = 'rolling_back' THEN
            v_audit_event := 'deploy_rollback_started';

          -- From ready_for_test: human accepts → accepted (terminal)
          -- or rejects → assigned (loop, no retry cap).
          WHEN p_from_status = 'ready_for_test' AND p_to_status = 'accepted' THEN
            v_needs_completed := true;
            v_audit_event := 'deploy_verified';
          WHEN p_from_status = 'ready_for_test' AND p_to_status = 'assigned' THEN
            -- Human-reject loop. No retry cap per Jonas's direction:
            -- the loop continues until the human approves.
            v_increments_retry := true;
            v_cap_retries := false;
            -- A fresh attempt needs a clean worker slot.
            v_clears_worker := true;

          WHEN p_from_status = 'rolling_back' AND p_to_status = 'rolled_back' THEN
            v_releases_lock := true; v_releases_mutex := true; v_needs_completed := true;
            v_audit_event := 'deploy_rolled_back';
          WHEN p_from_status = 'rolling_back' AND p_to_status = 'rollback_failed' THEN
            v_needs_completed := true;
            v_audit_event := 'deploy_rollback_failed';

          WHEN p_from_status = 'blocked' AND p_to_status = 'queued_for_lock' THEN NULL;
          WHEN p_from_status = 'blocked' AND p_to_status = 'cancelled' THEN
            v_needs_completed := true;

          ELSE
            RAISE EXCEPTION 'fence_and_transition: invalid transition % → %',
              p_from_status, p_to_status;
        END CASE;

        IF v_increments_retry THEN
          v_new_retry := v_current.retry_count + 1;
          IF v_cap_retries AND v_new_retry > MAX_RETRIES THEN
            v_new_status := 'blocked';
            v_forced_blocked := true;
            v_releases_lock := true;
            v_clears_worker := true;
            v_needs_completed := false;
            v_failure_reason := concat(
              'max_retries_exceeded: requested ',
              p_to_status::text,
              ', retry ',
              v_new_retry::text,
              ' of ',
              MAX_RETRIES::text
            );
            v_audit_event := 'task_blocked';
          END IF;
        ELSE
          v_new_retry := v_current.retry_count;
        END IF;

        IF v_sets_deploying AND NOT v_forced_blocked THEN
          v_mutex_lease := public.deploy_mutex_acquire(
            v_current.project_id, p_task_id, p_worker_id
          );
          IF v_mutex_lease IS NULL THEN
            RAISE EXCEPTION 'fence_and_transition: deploy_mutex held by another active deployer for project %',
              v_current.project_id;
          END IF;
        END IF;

        UPDATE public.agent_tasks
           SET status        = v_new_status,
               lease_version = public.agent_tasks.lease_version + 1,
               retry_count   = v_new_retry,
               completed_at  = CASE WHEN v_needs_completed THEN now() ELSE completed_at END,
               worker_id     = CASE WHEN v_clears_worker THEN NULL ELSE worker_id END,
               worker_handle = CASE WHEN v_clears_worker THEN NULL ELSE worker_handle END,
               started_at    = CASE WHEN v_clears_worker THEN NULL ELSE started_at END,
               heartbeat_at  = CASE WHEN v_clears_worker THEN NULL ELSE heartbeat_at END,
               failure_reason = COALESCE(
                 v_failure_reason,
                 p_payload->>'failure_reason',
                 failure_reason
               ),
               plan                       = COALESCE(p_payload->>'plan', plan),
               branch_name                = COALESCE(p_payload->>'branch_name', branch_name),
               approved_base_sha          = COALESCE(p_payload->>'approved_base_sha', approved_base_sha),
               approved_head_sha          = COALESCE(p_payload->>'approved_head_sha', approved_head_sha),
               review_decision            = COALESCE(
                 (p_payload->>'review_decision')::public.review_decision_enum, review_decision
               ),
               review_model_used          = COALESCE(p_payload->>'review_model_used', review_model_used),
               review_score               = COALESCE((p_payload->>'review_score')::int, review_score),
               review_notes_md            = COALESCE(p_payload->>'review_notes_md', review_notes_md),
               audit_notes_md             = COALESCE(p_payload->>'audit_notes_md', audit_notes_md),
               audit_status               = COALESCE(p_payload->>'audit_status', audit_status),
               review_attempts            = CASE
                 WHEN p_from_status = 'review' AND p_to_status = 'changes_requested'
                 THEN review_attempts + 1
                 ELSE review_attempts
               END,
               files_changed              = COALESCE(p_payload->'files_changed', files_changed),
               github_pr_number           = COALESCE((p_payload->>'github_pr_number')::int, github_pr_number),
               agent_branch_published_at  = COALESCE(
                 (p_payload->>'agent_branch_published_at')::timestamptz, agent_branch_published_at
               ),
               merged_commit_sha          = COALESCE(p_payload->>'merged_commit_sha', merged_commit_sha),
               applied_desired_state_id   = COALESCE(
                 (p_payload->>'applied_desired_state_id')::uuid, applied_desired_state_id
               ),
               rollback_pr_number         = COALESCE((p_payload->>'rollback_pr_number')::int, rollback_pr_number),
               rollback_commit_sha        = COALESCE(p_payload->>'rollback_commit_sha', rollback_commit_sha),
               rollback_desired_state_id  = COALESCE(
                 (p_payload->>'rollback_desired_state_id')::uuid, rollback_desired_state_id
               ),
               human_approved_at          = COALESCE(
                 (p_payload->>'human_approved_at')::timestamptz, human_approved_at
               ),
               human_approved_by          = COALESCE(
                 (p_payload->>'human_approved_by')::uuid, human_approved_by
               )
         WHERE id            = p_task_id
           AND status        = p_from_status
           AND lease_version = p_expected_lease
        RETURNING lease_version INTO v_new_lease;

        IF v_new_lease IS NULL THEN
          RAISE EXCEPTION 'fence_and_transition: concurrent mutation between SELECT FOR UPDATE and UPDATE (should be impossible)';
        END IF;

        IF v_releases_lock THEN
          UPDATE public.module_locks
             SET holder_task_id    = NULL,
                 holder_worker_id  = NULL,
                 acquired_at       = NULL,
                 expires_at        = NULL,
                 lease_version     = public.module_locks.lease_version + 1
           WHERE project_id     = v_current.project_id
             AND module         = v_current.module
             AND holder_task_id = p_task_id;
          IF NOT FOUND THEN
            PERFORM public.append_audit_event(
              v_current.project_id, p_task_id, v_current.report_id,
              'lock_fenced'::public.audit_event_enum,
              'system'::public.actor_kind_enum,
              'fence_and_transition',
              jsonb_build_object(
                'reason', 'release_expected_lock_not_held',
                'module', v_current.module
              ),
              NULL::varchar(32), NULL::varchar(32), NULL::varchar(64), NULL::varchar(32)
            );
          END IF;
        END IF;

        IF v_releases_mutex THEN
          UPDATE public.deploy_mutex
             SET holder_task_id    = NULL,
                 holder_worker_id  = NULL,
                 acquired_at       = NULL,
                 last_heartbeat_at = NULL,
                 expires_at        = NULL,
                 lease_version     = public.deploy_mutex.lease_version + 1
           WHERE project_id     = v_current.project_id
             AND holder_task_id = p_task_id;
          IF NOT FOUND THEN
            PERFORM public.append_audit_event(
              v_current.project_id, p_task_id, v_current.report_id,
              'lock_fenced'::public.audit_event_enum,
              'system'::public.actor_kind_enum,
              'fence_and_transition',
              jsonb_build_object('reason', 'release_expected_mutex_not_held'),
              NULL::varchar(32), NULL::varchar(32), NULL::varchar(64), NULL::varchar(32)
            );
          END IF;
        END IF;

        IF v_new_status = 'rollback_failed' THEN
          UPDATE public.module_locks
             SET expires_at = 'infinity'::timestamptz
           WHERE project_id     = v_current.project_id
             AND module         = v_current.module
             AND holder_task_id = p_task_id;
          UPDATE public.deploy_mutex
             SET expires_at = 'infinity'::timestamptz
           WHERE project_id     = v_current.project_id
             AND holder_task_id = p_task_id;
        END IF;

        v_audit_details := jsonb_build_object(
          'requested_to_status', p_to_status::text,
          'actual_new_status',   v_new_status::text,
          'forced_blocked',      v_forced_blocked,
          'retry_count',         v_new_retry,
          'releases_lock',       v_releases_lock,
          'releases_mutex',      v_releases_mutex,
          'payload',             p_payload
        );

        PERFORM public.append_audit_event(
          v_current.project_id,
          p_task_id,
          v_current.report_id,
          v_audit_event,
          p_actor_kind,
          p_actor_name,
          v_audit_details,
          p_from_status::varchar(32),
          v_new_status::varchar(32),
          COALESCE(p_payload->>'merged_commit_sha', p_payload->>'approved_head_sha'),
          p_payload->>'review_decision'
        );

        RETURN v_new_lease;
      END;
      $fn$
    `);

    // Update seeded agent_configs: enable planner/auditor/summarizer,
    // clear system_prompts so every role sends its full instruction
    // via ask.txt at request time (deterministic, no DB drift).
    await queryRunner.query(`
      UPDATE public.agent_configs
         SET enabled = true,
             system_prompt = '',
             updated_at = now(),
             updated_by = 'migration_022'
       WHERE role IN ('classifier', 'planner', 'coder', 'reviewer', 'auditor', 'summarizer')
    `);

    // Grants for the new table + the one column family devloop_api
    // needs to read.
    await queryRunner.query(`
      GRANT SELECT, INSERT ON public.task_feedback TO devloop_api
    `);
    await queryRunner.query(`
      GRANT USAGE, SELECT ON SEQUENCE public.task_feedback_id_seq TO devloop_api
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Enum values cannot be removed without rebuilding the enum;
    // the table + new columns can be dropped.
    await queryRunner.query(`DROP TABLE IF EXISTS public.task_feedback`);
    await queryRunner.query(`
      ALTER TABLE public.agent_tasks
        DROP COLUMN IF EXISTS audit_status,
        DROP COLUMN IF EXISTS audit_notes_md,
        DROP COLUMN IF EXISTS review_notes_md,
        DROP COLUMN IF EXISTS human_approved_by,
        DROP COLUMN IF EXISTS human_approved_at
    `);
  }
}
