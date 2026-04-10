import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 004 — agent_tasks, module_locks, deploy_mutex.
 *
 * Scope (Fas 0.4):
 *   - agent_tasks: full columns per ARCHITECTURE.md §4.2 v4+ modifications
 *     with CHECK invariants (status vs required fields), indexes, and the
 *     partial unique index enforcing at-most-one deploy-stage task per project
 *     (§19 D6)
 *   - module_locks: per-project per-module advisory lock with lease version
 *   - deploy_mutex: per-project deploy serialization with explicit heartbeat
 *   - Grants to devloop_api: SELECT only. All mutations go through stored
 *     procedures added in Fas 0.5 (fence_and_transition, refresh_task,
 *     claim_assigned_task, deploy_mutex_*, lock_*).
 *
 * Deferred to Fas 0.5:
 *   - fence_and_transition, refresh_task, claim_assigned_task
 *   - acquire_module_lock, release_module_lock, renew_module_lock
 *   - deploy_mutex_acquire, deploy_mutex_renew, deploy_mutex_release,
 *     deploy_mutex_clear_if_stale
 *
 * Deferred to Fas 1.x (when reports table exists):
 *   - FK constraint on agent_tasks.report_id → reports(id)
 *
 * Deferred to later (when desired_state_history and project_configs exist):
 *   - FK on agent_tasks.applied_desired_state_id
 *   - FK on agent_tasks.rollback_desired_state_id
 *   - FK on agent_tasks.project_config_id
 *
 * Reversibility: down() drops tables in FK-reverse order and removes the
 * audit_events.task_id FK added in up().
 */
export class TaskTables1712700000004 implements MigrationInterface {
  name = 'TaskTables1712700000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- agent_tasks ---
    // All columns per §4.2 modifications. FKs where target tables exist;
    // others (report_id, applied_desired_state_id, rollback_desired_state_id,
    // project_config_id) are nullable/unconstrained until the target tables
    // are created in later phases. The invariants on those references are
    // enforced by stored procedures added in Fas 0.5.
    await queryRunner.query(`
      CREATE TABLE public.agent_tasks (
        id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id                  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
        report_id                   uuid NOT NULL,
        display_id                  varchar(64) NOT NULL,
        agent_name                  varchar(64) NOT NULL,
        module                      varchar(64) NOT NULL,
        risk_tier                   risk_tier_enum NOT NULL,
        status                      task_status_enum NOT NULL,

        branch_name                 varchar(255) NULL,
        plan                        text NULL,

        review_decision             review_decision_enum NULL,
        review_model_used           varchar(64) NULL,
        review_score                int NULL,
        review_attempts             int NOT NULL DEFAULT 0,
        approved_base_sha           varchar(64) NULL,
        approved_head_sha           varchar(64) NULL,

        github_pr_number            int NULL,
        agent_branch_published_at   timestamptz NULL,
        merged_commit_sha           varchar(64) NULL,

        applied_desired_state_id    uuid NULL,
        rollback_pr_number          int NULL,
        rollback_commit_sha         varchar(64) NULL,
        rollback_desired_state_id   uuid NULL,

        files_changed               jsonb NULL,
        regression_detected         boolean NOT NULL DEFAULT false,
        failure_reason              text NULL,

        retry_count                 int NOT NULL DEFAULT 0,

        lease_version               bigint NOT NULL DEFAULT 0,
        worker_id                   varchar(128) NULL,
        worker_handle               varchar(64) NULL,

        project_config_id           uuid NULL,

        heartbeat_at                timestamptz NULL,
        started_at                  timestamptz NULL,
        completed_at                timestamptz NULL,
        created_at                  timestamptz NOT NULL DEFAULT now(),
        updated_at                  timestamptz NOT NULL DEFAULT now(),

        -- Non-negativity + sanity
        CONSTRAINT agent_tasks_review_attempts_nonneg CHECK (review_attempts >= 0),
        CONSTRAINT agent_tasks_retry_count_nonneg CHECK (retry_count >= 0),
        CONSTRAINT agent_tasks_lease_version_nonneg CHECK (lease_version >= 0),
        CONSTRAINT agent_tasks_review_score_range CHECK (
          review_score IS NULL OR (review_score BETWEEN 0 AND 100)
        ),
        CONSTRAINT agent_tasks_display_id_nonempty CHECK (char_length(display_id) > 0),
        CONSTRAINT agent_tasks_agent_name_nonempty CHECK (char_length(agent_name) > 0),
        CONSTRAINT agent_tasks_module_nonempty CHECK (char_length(module) > 0),

        -- Status invariants (§19 D4, §6.2)
        -- status='approved' => approval fields must all be set
        CONSTRAINT agent_tasks_approved_requires_sha CHECK (
          status <> 'approved' OR (
            approved_head_sha IS NOT NULL
            AND approved_base_sha IS NOT NULL
            AND review_decision = 'approved'
          )
        ),
        -- status='merged' => merged_commit_sha must be set
        CONSTRAINT agent_tasks_merged_requires_sha CHECK (
          status <> 'merged' OR merged_commit_sha IS NOT NULL
        ),
        -- terminal states require completed_at
        CONSTRAINT agent_tasks_terminal_requires_completed CHECK (
          status NOT IN ('verified', 'rolled_back', 'rollback_failed', 'failed', 'cancelled')
          OR completed_at IS NOT NULL
        )
      );
    `);

    // Index: pickup queries filter by (project, status, created_at)
    await queryRunner.query(`
      CREATE INDEX idx_agent_tasks_project_status_created
        ON public.agent_tasks(project_id, status, created_at);
    `);

    // Index: stale-task detection scans non-terminal, non-blocked tasks by
    // heartbeat_at (§6.3). Partial predicate keeps the index small.
    await queryRunner.query(`
      CREATE INDEX idx_agent_tasks_stale
        ON public.agent_tasks(heartbeat_at)
        WHERE status NOT IN (
          'verified', 'rolled_back', 'rollback_failed',
          'failed', 'cancelled', 'queued_for_lock', 'blocked'
        );
    `);

    // Deploy-stage uniqueness (§19 D6): at most one non-terminal deploy-stage
    // task per project. Includes 'rollback_failed' so a stuck task blocks
    // new deploys until manual recovery releases it.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_agent_tasks_one_deploy_per_project
        ON public.agent_tasks(project_id)
        WHERE status IN (
          'deploying', 'merged', 'verifying', 'rolling_back', 'rollback_failed'
        );
    `);

    // FK support indexes
    await queryRunner.query(`
      CREATE INDEX idx_agent_tasks_report_id ON public.agent_tasks(report_id);
    `);

    // updated_at trigger — keeps the column honest without relying on every
    // caller setting it. Status-mutating code (fence_and_transition in 0.5)
    // will also set it explicitly in the same UPDATE for atomicity.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.agent_tasks_touch_updated_at()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $fn$
      BEGIN
        NEW.updated_at := now();
        RETURN NEW;
      END;
      $fn$;
    `);
    await queryRunner.query(`
      CREATE TRIGGER agent_tasks_touch_updated_at
        BEFORE UPDATE ON public.agent_tasks
        FOR EACH ROW
        EXECUTE FUNCTION public.agent_tasks_touch_updated_at();
    `);

    // --- module_locks ---
    // Per-project per-module advisory lock. Composite PK (project_id, module).
    //
    // FK ON DELETE RESTRICT: agent_tasks are terminal-persistent (never
    // deleted after reaching verified/rolled_back/failed/cancelled — they
    // remain in the audit trail forever). Therefore RESTRICT is safe: a
    // task cannot be deleted while it still holds a lock. Release must
    // happen via release_module_lock() in Fas 0.5 BEFORE any hypothetical
    // future admin-driven task deletion.
    //
    // SET NULL would conflict with the holder-consistency CHECK below,
    // because PG only nulls holder_task_id but leaves the other holder
    // columns untouched, which would violate the "fully held or fully free"
    // invariant.
    await queryRunner.query(`
      CREATE TABLE public.module_locks (
        project_id        uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
        module            varchar(64) NOT NULL,
        holder_task_id    uuid NULL REFERENCES public.agent_tasks(id) ON DELETE RESTRICT,
        holder_worker_id  varchar(128) NULL,
        acquired_at       timestamptz NULL,
        expires_at        timestamptz NULL,
        lease_version     bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, module),
        CONSTRAINT module_locks_lease_version_nonneg CHECK (lease_version >= 0),
        CONSTRAINT module_locks_module_nonempty CHECK (char_length(module) > 0),
        -- Holder consistency: either fully held (ALL holder fields set) or
        -- fully free (ALL holder fields NULL). No partial state allowed.
        CONSTRAINT module_locks_holder_consistency CHECK (
          (
            holder_task_id   IS NULL
            AND holder_worker_id IS NULL
            AND acquired_at    IS NULL
            AND expires_at     IS NULL
          )
          OR
          (
            holder_task_id   IS NOT NULL
            AND holder_worker_id IS NOT NULL
            AND acquired_at    IS NOT NULL
            AND expires_at     IS NOT NULL
          )
        )
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_module_locks_holder_task ON public.module_locks(holder_task_id)
        WHERE holder_task_id IS NOT NULL;
    `);

    // --- deploy_mutex ---
    // Single row per project. Serializes deploy-stage work. Heartbeat-renewed
    // by the holding deployer; cleared if last_heartbeat_at lapses past the
    // expiry grace window.
    //
    // Same FK RESTRICT rationale as module_locks above: tasks are terminal-
    // persistent, release goes through deploy_mutex_release() in Fas 0.5.
    await queryRunner.query(`
      CREATE TABLE public.deploy_mutex (
        project_id         uuid PRIMARY KEY REFERENCES public.projects(id) ON DELETE CASCADE,
        holder_task_id     uuid NULL REFERENCES public.agent_tasks(id) ON DELETE RESTRICT,
        holder_worker_id   varchar(128) NULL,
        acquired_at        timestamptz NULL,
        last_heartbeat_at  timestamptz NULL,
        expires_at         timestamptz NULL,
        lease_version      bigint NOT NULL DEFAULT 0,
        CONSTRAINT deploy_mutex_lease_version_nonneg CHECK (lease_version >= 0),
        -- Holder consistency: ALL holder fields set when held, ALL NULL when free.
        CONSTRAINT deploy_mutex_holder_consistency CHECK (
          (
            holder_task_id    IS NULL
            AND holder_worker_id  IS NULL
            AND acquired_at       IS NULL
            AND last_heartbeat_at IS NULL
            AND expires_at        IS NULL
          )
          OR
          (
            holder_task_id    IS NOT NULL
            AND holder_worker_id  IS NOT NULL
            AND acquired_at       IS NOT NULL
            AND last_heartbeat_at IS NOT NULL
            AND expires_at        IS NOT NULL
          )
        )
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_deploy_mutex_holder_task ON public.deploy_mutex(holder_task_id)
        WHERE holder_task_id IS NOT NULL;
    `);

    // --- Add FK from audit_events.task_id to agent_tasks(id) ---
    // Now that agent_tasks exists, we can enforce the relationship.
    // ON DELETE RESTRICT: agent_tasks cannot be deleted while audit events
    // reference them. This is the intended behavior — audit rows are
    // append-only and tasks are terminal-persistent.
    // SET NULL would trigger an UPDATE on audit_events, which the
    // immutability trigger would block anyway, so RESTRICT is the only
    // consistent choice.
    await queryRunner.query(`
      ALTER TABLE public.audit_events
        ADD CONSTRAINT audit_events_task_id_fkey
        FOREIGN KEY (task_id) REFERENCES public.agent_tasks(id) ON DELETE RESTRICT;
    `);

    // --- Grants per §19 D26 ---
    // devloop_api: SELECT only on all three tables. All mutations must go
    // through stored procedures added in Fas 0.5.
    await queryRunner.query(`GRANT SELECT ON public.agent_tasks TO devloop_api;`);
    await queryRunner.query(`GRANT SELECT ON public.module_locks TO devloop_api;`);
    await queryRunner.query(`GRANT SELECT ON public.deploy_mutex TO devloop_api;`);

    // Defense-in-depth: explicitly revoke ALL on these tables from PUBLIC.
    await queryRunner.query(`REVOKE ALL ON public.agent_tasks FROM PUBLIC;`);
    await queryRunner.query(`REVOKE ALL ON public.module_locks FROM PUBLIC;`);
    await queryRunner.query(`REVOKE ALL ON public.deploy_mutex FROM PUBLIC;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop FK from audit_events first (so agent_tasks can be dropped)
    await queryRunner.query(`
      ALTER TABLE public.audit_events DROP CONSTRAINT IF EXISTS audit_events_task_id_fkey;
    `);

    // Revoke grants (defensive; DROP TABLE would remove them implicitly)
    await queryRunner.query(`REVOKE ALL ON public.deploy_mutex FROM devloop_api;`);
    await queryRunner.query(`REVOKE ALL ON public.module_locks FROM devloop_api;`);
    await queryRunner.query(`REVOKE ALL ON public.agent_tasks FROM devloop_api;`);

    // Drop in FK-reverse order
    await queryRunner.query(`DROP TABLE IF EXISTS public.deploy_mutex;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.module_locks;`);

    // Drop the updated_at trigger function and table
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS agent_tasks_touch_updated_at ON public.agent_tasks;
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.agent_tasks_touch_updated_at();
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS public.agent_tasks;`);
  }
}
