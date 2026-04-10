import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 005 — state machine stored procedures.
 *
 * Scope (Fas 0.5): the core DB-enforced correctness layer for the task
 * state machine. Five SECURITY DEFINER procedures that implement:
 *
 *   1. acquire_module_lock — atomic upsert acquisition with stale takeover
 *   2. deploy_mutex_acquire — same pattern for per-project deploy serialization
 *   3. claim_assigned_task — worker manager's atomic spawn claim (assigned → in_progress)
 *   4. refresh_task — heartbeat without lease bump (renews agent_tasks + module_locks)
 *   5. fence_and_transition — the ONLY function that changes agent_tasks.status
 *      and bumps lease_version. Validates the (from, to) pair against a hard-
 *      coded transition table, applies lock/mutex release per §19 D4/D5,
 *      handles retry_count accounting, emits audit events via append_audit_event.
 *
 * All procedures:
 *   - SECURITY DEFINER (run as devloop_owner)
 *   - SET search_path = pg_catalog, pg_temp (public NOT in path)
 *   - Full schema qualification of non-catalog objects
 *   - REVOKE ALL FROM PUBLIC, GRANT EXECUTE TO devloop_api as interim
 *     runtime caller (future migrations will shift to devloop_orch, devloop_rev,
 *     devloop_dep, devloop_wm per §19 D26 when those roles are created)
 *
 * KEY INVARIANTS ENFORCED:
 *   - lease_version is bumped ONLY by fence_and_transition and claim_assigned_task.
 *     refresh_task does NOT bump it (§19 D7). This keeps callers' in-memory
 *     lease stable across heartbeats.
 *   - On rollback_failed, BOTH module_lock and deploy_mutex are RETAINED
 *     (§19 D5). Release only via manual recovery (not in this migration).
 *   - changes_requested → assigned clears worker_id/worker_handle/started_at/
 *     heartbeat_at so the next claim_assigned_task call works.
 *   - retry_count is incremented only on specific retryable transitions,
 *     not by janitor. If retry_count+1 > MAX_RETRIES (3), the transition is
 *     forced to 'blocked' with failure_reason='max_retries_exceeded'.
 *   - approved → deploying acquires deploy_mutex atomically IN THE SAME
 *     transaction as the status update. If mutex is held by another active
 *     deployer, the whole transition fails. The partial unique index
 *     idx_agent_tasks_one_deploy_per_project is the hard DB-level backstop.
 *
 * Reversibility: down() drops all 5 procedures in reverse order.
 */
export class StateMachineProcs1712700000005 implements MigrationInterface {
  name = 'StateMachineProcs1712700000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ========================================================================
    // 1. acquire_module_lock
    // ========================================================================
    // Atomic upsert: either the row is free (holder_task_id IS NULL) or it
    // is stale (expires_at < now()). In both cases we take it. Returns the
    // new lease_version, or NULL if the lock is actively held by another task.
    // Caller must check for NULL and requeue/retry.
    //
    // Lock timeout: 15 minutes from acquisition, renewed by refresh_task.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.acquire_module_lock(
        p_project_id     uuid,
        p_module         varchar(64),
        p_task_id        uuid,
        p_worker_id      varchar(128)
      ) RETURNS bigint
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_new_lease bigint;
      BEGIN
        IF p_task_id IS NULL OR p_worker_id IS NULL OR p_project_id IS NULL
           OR p_module IS NULL
           OR char_length(p_module) = 0
           OR char_length(p_worker_id) = 0 THEN
          RAISE EXCEPTION 'acquire_module_lock: all arguments required and non-empty';
        END IF;

        INSERT INTO public.module_locks (
          project_id, module, holder_task_id, holder_worker_id,
          acquired_at, expires_at, lease_version
        ) VALUES (
          p_project_id, p_module, p_task_id, p_worker_id,
          now(), now() + interval '15 minutes', 1
        )
        ON CONFLICT (project_id, module) DO UPDATE
          SET holder_task_id   = EXCLUDED.holder_task_id,
              holder_worker_id = EXCLUDED.holder_worker_id,
              acquired_at      = EXCLUDED.acquired_at,
              expires_at       = EXCLUDED.expires_at,
              lease_version    = public.module_locks.lease_version + 1
          WHERE public.module_locks.holder_task_id IS NULL
             OR public.module_locks.expires_at < now()
        RETURNING lease_version INTO v_new_lease;

        RETURN v_new_lease;  -- NULL if lock is actively held by another task
      END;
      $fn$;
    `);

    await queryRunner.query(`
      REVOKE ALL ON FUNCTION public.acquire_module_lock(uuid, varchar, uuid, varchar) FROM PUBLIC;
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.acquire_module_lock(uuid, varchar, uuid, varchar) TO devloop_api;
    `);

    // ========================================================================
    // 2. deploy_mutex_acquire
    // ========================================================================
    // Same pattern as module_lock. Per-project single-row mutex. Grace window
    // 5 minutes from last heartbeat. Returns new lease_version, or NULL if
    // held by another active deployer.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.deploy_mutex_acquire(
        p_project_id  uuid,
        p_task_id     uuid,
        p_worker_id   varchar(128)
      ) RETURNS bigint
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_new_lease bigint;
      BEGIN
        IF p_task_id IS NULL OR p_worker_id IS NULL OR p_project_id IS NULL
           OR char_length(p_worker_id) = 0 THEN
          RAISE EXCEPTION 'deploy_mutex_acquire: all arguments required and non-empty';
        END IF;

        INSERT INTO public.deploy_mutex (
          project_id, holder_task_id, holder_worker_id,
          acquired_at, last_heartbeat_at, expires_at, lease_version
        ) VALUES (
          p_project_id, p_task_id, p_worker_id,
          now(), now(), now() + interval '5 minutes', 1
        )
        ON CONFLICT (project_id) DO UPDATE
          SET holder_task_id    = EXCLUDED.holder_task_id,
              holder_worker_id  = EXCLUDED.holder_worker_id,
              acquired_at       = EXCLUDED.acquired_at,
              last_heartbeat_at = EXCLUDED.last_heartbeat_at,
              expires_at        = EXCLUDED.expires_at,
              lease_version     = public.deploy_mutex.lease_version + 1
          WHERE public.deploy_mutex.holder_task_id IS NULL
             OR public.deploy_mutex.expires_at < now()
        RETURNING lease_version INTO v_new_lease;

        RETURN v_new_lease;
      END;
      $fn$;
    `);

    await queryRunner.query(`
      REVOKE ALL ON FUNCTION public.deploy_mutex_acquire(uuid, uuid, varchar) FROM PUBLIC;
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.deploy_mutex_acquire(uuid, uuid, varchar) TO devloop_api;
    `);

    // ========================================================================
    // 3. claim_assigned_task
    // ========================================================================
    // Worker manager's atomic claim for assigned → in_progress. Returns the
    // new lease_version on successful claim, or NULL if the task was not in
    // the expected state (already claimed, cancelled, wrong state, etc.).
    //
    // This function BUMPS lease_version because it's an ownership change,
    // not a heartbeat.
    //
    // Note: this does NOT verify that the task's module_lock is held by the
    // correct holder. Orchestrator's responsibility is to ensure the lock is
    // held before emitting the spawn IPC; WM trusts this invariant.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.claim_assigned_task(
        p_task_id        uuid,
        p_worker_id      varchar(128),
        p_worker_handle  varchar(64)
      ) RETURNS TABLE (
        out_lease_version bigint,
        out_agent_name    varchar(64),
        out_module        varchar(64),
        out_project_id    uuid,
        out_display_id    varchar(64)
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      BEGIN
        IF p_task_id IS NULL OR p_worker_id IS NULL OR p_worker_handle IS NULL
           OR char_length(p_worker_id) = 0 OR char_length(p_worker_handle) = 0 THEN
          RAISE EXCEPTION 'claim_assigned_task: all arguments required and non-empty';
        END IF;

        -- Use "out_" prefixed OUT parameter names so the UPDATE ... RETURNING
        -- clause below unambiguously references table columns without colliding.
        RETURN QUERY
        WITH claimed AS (
          UPDATE public.agent_tasks
             SET status        = 'in_progress',
                 worker_id     = p_worker_id,
                 worker_handle = p_worker_handle,
                 started_at    = now(),
                 heartbeat_at  = now(),
                 lease_version = public.agent_tasks.lease_version + 1
           WHERE id            = p_task_id
             AND status        = 'assigned'
             AND worker_id     IS NULL
          RETURNING
            public.agent_tasks.lease_version AS l,
            public.agent_tasks.agent_name    AS a,
            public.agent_tasks.module        AS m,
            public.agent_tasks.project_id    AS p,
            public.agent_tasks.display_id    AS d
        ),
        audit AS (
          SELECT public.append_audit_event(
            (SELECT p FROM claimed),
            p_task_id,
            NULL::uuid,
            'worker_spawned'::public.audit_event_enum,
            'agent'::public.actor_kind_enum,
            p_worker_id,
            jsonb_build_object('worker_handle', p_worker_handle),
            'assigned'::varchar(32),
            'in_progress'::varchar(32),
            NULL::varchar(64),
            NULL::varchar(32)
          ) AS audit_id
          WHERE EXISTS (SELECT 1 FROM claimed)
        )
        SELECT c.l, c.a, c.m, c.p, c.d
        FROM claimed c, audit;
      END;
      $fn$;
    `);

    await queryRunner.query(`
      REVOKE ALL ON FUNCTION public.claim_assigned_task(uuid, varchar, varchar) FROM PUBLIC;
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.claim_assigned_task(uuid, varchar, varchar) TO devloop_api;
    `);

    // ========================================================================
    // 4. refresh_task
    // ========================================================================
    // Ordinary heartbeat — DOES NOT bump agent_tasks.lease_version (per §19 D7).
    // Caller's in-memory lease remains valid across heartbeats. Updates:
    //   - agent_tasks.heartbeat_at = now()
    //   - module_locks.expires_at = now() + 15 min (for the holding task)
    //
    // Returns true if both updates succeeded, false if the task row was fenced
    // (wrong lease_version) or if the module lock is no longer held by this
    // task (lost-lock situation — caller must abort).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.refresh_task(
        p_task_id         uuid,
        p_expected_lease  bigint,
        p_expected_status public.task_status_enum
      ) RETURNS boolean
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_project_id  uuid;
        v_module      varchar(64);
        v_updated     integer;
      BEGIN
        IF p_task_id IS NULL OR p_expected_lease IS NULL OR p_expected_status IS NULL THEN
          RAISE EXCEPTION 'refresh_task: all arguments required';
        END IF;

        -- Step 1: Read and row-lock the task. Verifies lease AND status.
        -- Returns false immediately on fenced/wrong-state — no partial updates.
        SELECT project_id, module INTO v_project_id, v_module
          FROM public.agent_tasks
         WHERE id            = p_task_id
           AND lease_version = p_expected_lease
           AND status        = p_expected_status
           FOR UPDATE;

        IF v_project_id IS NULL THEN
          RETURN false;  -- fenced or wrong status, nothing touched
        END IF;

        -- Step 2: Renew module lock. Require exactly one row updated to confirm
        -- we still hold the lock. If lost, audit and return false WITHOUT
        -- touching any heartbeat fields. Per §19 D7 we do NOT bump
        -- agent_tasks.lease_version from heartbeat paths.
        UPDATE public.module_locks
           SET expires_at = now() + interval '15 minutes'
         WHERE project_id     = v_project_id
           AND module         = v_module
           AND holder_task_id = p_task_id;

        GET DIAGNOSTICS v_updated = ROW_COUNT;
        IF v_updated != 1 THEN
          PERFORM public.append_audit_event(
            v_project_id, p_task_id, NULL::uuid,
            'lock_fenced'::public.audit_event_enum,
            'system'::public.actor_kind_enum,
            'refresh_task',
            jsonb_build_object(
              'reason', 'heartbeat_lost_module_lock',
              'module', v_module
            ),
            NULL::varchar(32), NULL::varchar(32), NULL::varchar(64), NULL::varchar(32)
          );
          RETURN false;
        END IF;

        -- Step 3: Renew deploy_mutex if held (best-effort). The mutex is only
        -- held during deploy-stage states; for other states this is a no-op
        -- that does nothing, which is correct. We do NOT check ROW_COUNT
        -- because non-deploy states legitimately have no mutex row.
        UPDATE public.deploy_mutex
           SET last_heartbeat_at = now(),
               expires_at        = now() + interval '5 minutes'
         WHERE project_id     = v_project_id
           AND holder_task_id = p_task_id;

        -- Step 4: Advance task heartbeat_at. Use the same lease/status guard
        -- as step 1 so we never advance heartbeat for a task that has changed
        -- state in the narrow window between step 1 and here.
        UPDATE public.agent_tasks
           SET heartbeat_at = now()
         WHERE id            = p_task_id
           AND lease_version = p_expected_lease
           AND status        = p_expected_status;

        RETURN true;
      END;
      $fn$;
    `);

    await queryRunner.query(`
      REVOKE ALL ON FUNCTION public.refresh_task(uuid, bigint, public.task_status_enum) FROM PUBLIC;
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.refresh_task(uuid, bigint, public.task_status_enum) TO devloop_api;
    `);

    // ========================================================================
    // 5. fence_and_transition
    // ========================================================================
    // The ONLY function that mutates agent_tasks.status. Validates (from, to)
    // against a hardcoded transition table, applies the transition's side
    // effects (lock/mutex release, worker field clearing, retry increment,
    // mutex acquisition for approved→deploying), updates the task row,
    // and emits an audit event.
    //
    // Returns the new lease_version, or raises exception on any failure:
    //   - fenced (wrong lease)
    //   - wrong current status
    //   - invalid transition
    //   - unique constraint violation (another task already in deploy-stage)
    //   - mutex held by another active deployer
    //   - retry exhaustion (transition forced to 'blocked')
    //
    // The caller must pass p_worker_id for transitions that need to acquire
    // deploy_mutex (approved → deploying). For other transitions, worker_id
    // is optional.
    //
    // p_payload is a jsonb bag of optional fields to set on the row. Keys:
    //   plan, branch_name, approved_base_sha, approved_head_sha,
    //   review_decision, review_model_used, review_score, files_changed,
    //   github_pr_number, agent_branch_published_at, merged_commit_sha,
    //   applied_desired_state_id, rollback_pr_number, rollback_commit_sha,
    //   rollback_desired_state_id, failure_reason
    //
    // MAX_RETRIES is 3 per §19 D22. On the specific transition
    // changes_requested → assigned, retry_count is incremented. If
    // retry_count+1 > 3, the transition is FORCED to 'blocked' with
    // failure_reason='max_retries_exceeded' and audit_event_type='task_blocked'.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.fence_and_transition(
        p_task_id         uuid,
        p_expected_lease  bigint,
        p_from_status     public.task_status_enum,
        p_to_status       public.task_status_enum,
        p_actor_name      varchar(128),
        p_actor_kind      public.actor_kind_enum DEFAULT 'agent',
        p_payload         jsonb      DEFAULT '{}'::jsonb,
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
      BEGIN
        IF p_task_id IS NULL OR p_expected_lease IS NULL
           OR p_from_status IS NULL OR p_to_status IS NULL
           OR p_actor_name IS NULL OR char_length(p_actor_name) = 0 THEN
          RAISE EXCEPTION 'fence_and_transition: required arguments missing or empty';
        END IF;

        -- Normalize payload: treat NULL as empty object.
        p_payload := COALESCE(p_payload, '{}'::jsonb);

        -- Lock the task row for the duration of this transaction
        SELECT * INTO v_current FROM public.agent_tasks
         WHERE id = p_task_id FOR UPDATE;

        IF v_current.id IS NULL THEN
          RAISE EXCEPTION 'fence_and_transition: task % not found', p_task_id;
        END IF;

        -- Fence check: status and lease_version must match caller's expectation
        IF v_current.status <> p_from_status THEN
          RAISE EXCEPTION 'fence_and_transition: status mismatch (expected %, actual %)',
            p_from_status, v_current.status;
        END IF;
        IF v_current.lease_version <> p_expected_lease THEN
          RAISE EXCEPTION 'fence_and_transition: lease mismatch (expected %, actual %) — stale caller',
            p_expected_lease, v_current.lease_version;
        END IF;

        -- ====================================================================
        -- Transition table validation + side-effect flags
        -- ====================================================================
        -- Each valid (from, to) pair sets flags for what side effects to apply.
        -- Any pair not in this table raises an exception.
        CASE
          -- From queued_for_lock
          WHEN p_from_status = 'queued_for_lock' AND p_to_status = 'assigned' THEN
            NULL;  -- orchestrator already acquired lock before calling
          WHEN p_from_status = 'queued_for_lock' AND p_to_status = 'cancelled' THEN
            v_needs_completed := true;

          -- From assigned (note: assigned → in_progress is via claim_assigned_task)
          WHEN p_from_status = 'assigned' AND p_to_status = 'cancelled' THEN
            v_releases_lock := true; v_needs_completed := true;
          WHEN p_from_status = 'assigned' AND p_to_status = 'failed' THEN
            -- janitor case: spawn_timeout
            v_releases_lock := true; v_needs_completed := true;
          WHEN p_from_status = 'assigned' AND p_to_status = 'blocked' THEN
            -- Clear worker fields so a future blocked → queued_for_lock → assigned
            -- path lands in a claim_assigned_task-claimable state.
            v_releases_lock := true; v_clears_worker := true;

          -- From in_progress
          WHEN p_from_status = 'in_progress' AND p_to_status = 'review' THEN
            NULL;  -- lock retained
          WHEN p_from_status = 'in_progress' AND p_to_status = 'blocked' THEN
            v_releases_lock := true; v_clears_worker := true;
          WHEN p_from_status = 'in_progress' AND p_to_status = 'failed' THEN
            v_releases_lock := true; v_needs_completed := true;
          WHEN p_from_status = 'in_progress' AND p_to_status = 'cancelled' THEN
            v_releases_lock := true; v_needs_completed := true;

          -- From review
          WHEN p_from_status = 'review' AND p_to_status = 'approved' THEN
            NULL;  -- lock retained
          WHEN p_from_status = 'review' AND p_to_status = 'changes_requested' THEN
            NULL;  -- lock retained, retry increment happens on re-entry to assigned
          WHEN p_from_status = 'review' AND p_to_status = 'blocked' THEN
            v_releases_lock := true; v_clears_worker := true;
          WHEN p_from_status = 'review' AND p_to_status = 'cancelled' THEN
            v_releases_lock := true; v_needs_completed := true;

          -- From changes_requested
          WHEN p_from_status = 'changes_requested' AND p_to_status = 'assigned' THEN
            -- RETRY: increment retry_count, clear worker fields
            v_clears_worker := true;
            v_increments_retry := true;
          WHEN p_from_status = 'changes_requested' AND p_to_status = 'cancelled' THEN
            v_releases_lock := true; v_needs_completed := true;

          -- From approved
          WHEN p_from_status = 'approved' AND p_to_status = 'deploying' THEN
            -- Acquires deploy_mutex atomically in this same transaction.
            -- The DB unique index idx_agent_tasks_one_deploy_per_project is
            -- the hard backstop; the mutex is for fast in-process coordination.
            IF p_worker_id IS NULL OR char_length(p_worker_id) = 0 THEN
              RAISE EXCEPTION 'fence_and_transition: approved → deploying requires p_worker_id';
            END IF;
            v_sets_deploying := true;
          WHEN p_from_status = 'approved' AND p_to_status = 'cancelled' THEN
            v_releases_lock := true; v_needs_completed := true;

          -- From deploying
          WHEN p_from_status = 'deploying' AND p_to_status = 'merged' THEN
            NULL;  -- lock + mutex retained
          WHEN p_from_status = 'deploying' AND p_to_status = 'review' THEN
            -- Stale SHA: bounce back to review for re-eval. Mutex released,
            -- lock retained (reviewer continues to own it).
            v_releases_mutex := true;
          WHEN p_from_status = 'deploying' AND p_to_status = 'failed' THEN
            v_releases_lock := true; v_releases_mutex := true; v_needs_completed := true;

          -- From merged
          WHEN p_from_status = 'merged' AND p_to_status = 'verifying' THEN
            NULL;  -- lock + mutex retained
          WHEN p_from_status = 'merged' AND p_to_status = 'failed' THEN
            v_releases_lock := true; v_releases_mutex := true; v_needs_completed := true;

          -- From verifying
          WHEN p_from_status = 'verifying' AND p_to_status = 'verified' THEN
            -- Terminal success
            v_releases_lock := true; v_releases_mutex := true; v_needs_completed := true;
            v_audit_event := 'deploy_verified';
          WHEN p_from_status = 'verifying' AND p_to_status = 'rolling_back' THEN
            NULL;  -- lock + mutex retained
            v_audit_event := 'deploy_rollback_started';

          -- From rolling_back
          WHEN p_from_status = 'rolling_back' AND p_to_status = 'rolled_back' THEN
            v_releases_lock := true; v_releases_mutex := true; v_needs_completed := true;
            v_audit_event := 'deploy_rolled_back';
          WHEN p_from_status = 'rolling_back' AND p_to_status = 'rollback_failed' THEN
            -- §19 D5: BOTH lock and mutex RETAINED, and made non-stealable.
            -- See the "seal to infinity" block below after the UPDATE.
            v_needs_completed := true;
            v_audit_event := 'deploy_rollback_failed';

          -- From blocked
          WHEN p_from_status = 'blocked' AND p_to_status = 'queued_for_lock' THEN
            NULL;  -- no lock currently held
          WHEN p_from_status = 'blocked' AND p_to_status = 'cancelled' THEN
            v_needs_completed := true;

          -- No outgoing transitions from terminal states
          ELSE
            RAISE EXCEPTION 'fence_and_transition: invalid transition % → %',
              p_from_status, p_to_status;
        END CASE;

        -- ====================================================================
        -- Retry handling for changes_requested → assigned
        -- ====================================================================
        IF v_increments_retry THEN
          v_new_retry := v_current.retry_count + 1;
          IF v_new_retry > MAX_RETRIES THEN
            -- Force transition to 'blocked' instead. Clear worker fields so
            -- a future recovery (operator-driven blocked → queued_for_lock →
            -- assigned) lands in a claimable state. Do NOT set completed_at
            -- because 'blocked' is not a terminal state.
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

        -- ====================================================================
        -- Acquire deploy_mutex if transitioning into deploying
        -- ====================================================================
        IF v_sets_deploying AND NOT v_forced_blocked THEN
          v_mutex_lease := public.deploy_mutex_acquire(
            v_current.project_id, p_task_id, p_worker_id
          );
          IF v_mutex_lease IS NULL THEN
            RAISE EXCEPTION 'fence_and_transition: deploy_mutex held by another active deployer for project %',
              v_current.project_id;
          END IF;
        END IF;

        -- ====================================================================
        -- UPDATE the task row with the new status + payload fields
        -- ====================================================================
        -- The partial unique index idx_agent_tasks_one_deploy_per_project is
        -- checked by PG on this UPDATE. If another task is already in deploy-
        -- stage for the same project, this fails with 23505 (unique violation).
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
               )
         WHERE id            = p_task_id
           AND status        = p_from_status
           AND lease_version = p_expected_lease
        RETURNING lease_version INTO v_new_lease;

        IF v_new_lease IS NULL THEN
          RAISE EXCEPTION 'fence_and_transition: concurrent mutation between SELECT FOR UPDATE and UPDATE (should be impossible)';
        END IF;

        -- ====================================================================
        -- Release locks/mutex AFTER the status update (so a concurrent
        -- acquire_module_lock observing no holder can only happen after we've
        -- successfully transitioned out of a holding state).
        -- ====================================================================
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
          -- Emit an audit event if the lock was NOT actually held by this task.
          -- Not a hard failure (the transition still succeeds) but flags a
          -- potential invariant drift that operators should investigate.
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

        -- ====================================================================
        -- Special handling for rollback_failed: seal lock + mutex to infinity
        -- so stale-takeover predicates (expires_at < now()) never re-claim them
        -- until manual recovery. Per §19 D5.
        -- ====================================================================
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

        -- ====================================================================
        -- Emit audit event
        -- ====================================================================
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
      $fn$;
    `);

    await queryRunner.query(`
      REVOKE ALL ON FUNCTION public.fence_and_transition(uuid, bigint, public.task_status_enum, public.task_status_enum, varchar, public.actor_kind_enum, jsonb, varchar) FROM PUBLIC;
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.fence_and_transition(uuid, bigint, public.task_status_enum, public.task_status_enum, varchar, public.actor_kind_enum, jsonb, varchar) TO devloop_api;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse dependency order
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.fence_and_transition(uuid, bigint, public.task_status_enum, public.task_status_enum, varchar, public.actor_kind_enum, jsonb, varchar);
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.refresh_task(uuid, bigint, public.task_status_enum);
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.claim_assigned_task(uuid, varchar, varchar);
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.deploy_mutex_acquire(uuid, uuid, varchar);
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.acquire_module_lock(uuid, varchar, uuid, varchar);
    `);
  }
}
