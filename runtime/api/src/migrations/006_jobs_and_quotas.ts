import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 006 — jobs queue + quota_usage + atomic quota procedures.
 *
 * Scope (Fas 0.6):
 *   - public.jobs: durable job queue table backing orchestrator/reviewer/
 *     deployer queues per ARCHITECTURE.md §4.2. NOTIFY is wakeup only;
 *     this table is the source of truth for unfinished work.
 *   - public.quota_usage_global: global (project_id=NULL) period+metric
 *     cost caps. Period keys like '2026-04-10' (daily) or '2026-04-10-14'
 *     (hourly). Metrics: openai_calls, openai_input_tokens,
 *     openai_output_tokens, usd_cents.
 *   - public.quota_usage_project: same but per project.
 *   - public.reserve_quota(): atomic reservation that returns true only
 *     if the reservation would not exceed limit_value. No separate lock
 *     needed — the WHERE clause is the atomic check.
 *   - public.reconcile_quota(): post-call adjustment when actual usage
 *     differs from reserved (e.g., OpenAI returned fewer tokens than
 *     estimated). Always applies the delta; never rejects.
 *
 * Grants per §19 D26:
 *   - devloop_api gets SELECT on jobs, quota_usage_*, INSERT on jobs
 *     (orchestrator enqueue path), UPDATE on jobs (status/claim/result
 *     updates by consumers).
 *   - devloop_api gets EXECUTE on reserve_quota and reconcile_quota.
 *   - Direct UPDATE on quota_usage_* is NOT granted — all mutations
 *     go through the stored procedures.
 *
 * Deferred to later phases:
 *   - project_configs (Fas 0.7)
 *   - signing_keys (Fas 0.7)
 *   - desired_state_history (Fas 0.7)
 *   - host_health + host_health_alerts (Fas 0.8)
 *   - branch_protection_checks (Fas 0.8)
 *   - Reports tables (Fas 1.x)
 */
export class JobsAndQuotas1712700000006 implements MigrationInterface {
  name = 'JobsAndQuotas1712700000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ========================================================================
    // jobs queue
    // ========================================================================
    await queryRunner.query(`
      CREATE TABLE public.jobs (
        id             bigserial PRIMARY KEY,
        queue          varchar(64) NOT NULL,
        payload        jsonb NOT NULL,
        status         public.job_status_enum NOT NULL DEFAULT 'pending',
        attempts       int NOT NULL DEFAULT 0,
        max_attempts   int NOT NULL DEFAULT 5,
        claimed_by     varchar(128) NULL,
        claimed_at     timestamptz NULL,
        lease_until    timestamptz NULL,
        result         jsonb NULL,
        last_error     text NULL,
        created_at     timestamptz NOT NULL DEFAULT now(),
        completed_at   timestamptz NULL,
        CONSTRAINT jobs_queue_nonempty CHECK (char_length(queue) > 0),
        CONSTRAINT jobs_attempts_nonneg CHECK (attempts >= 0),
        CONSTRAINT jobs_max_attempts_positive CHECK (max_attempts > 0),
        -- Claim consistency: claimed_by/claimed_at/lease_until are all-or-nothing
        CONSTRAINT jobs_claim_consistency CHECK (
          (
            claimed_by IS NULL AND claimed_at IS NULL AND lease_until IS NULL
          )
          OR
          (
            claimed_by IS NOT NULL AND claimed_at IS NOT NULL AND lease_until IS NOT NULL
          )
        ),
        -- Status-tied claim fields: pending must have no claim, claimed must have claim.
        -- Prevents "stuck claimed row with NULL lease" leaks under direct DML.
        CONSTRAINT jobs_status_claim_tie CHECK (
          (status = 'pending'  AND claimed_by IS NULL)
          OR
          (status = 'claimed'  AND claimed_by IS NOT NULL)
          OR
          status IN ('done', 'failed')
        ),
        -- Terminal status requires completed_at
        CONSTRAINT jobs_terminal_requires_completed CHECK (
          status NOT IN ('done', 'failed') OR completed_at IS NOT NULL
        ),
        -- Non-terminal status must NOT have completed_at set
        CONSTRAINT jobs_nonterminal_no_completed CHECK (
          status IN ('done', 'failed') OR completed_at IS NULL
        )
      );
    `);

    // Index: dequeue hot path — pending/claimed jobs by queue + oldest first
    await queryRunner.query(`
      CREATE INDEX idx_jobs_queue_pending
        ON public.jobs(queue, created_at)
        WHERE status IN ('pending', 'claimed');
    `);

    // Index: stale reclaim scanner — claimed jobs by lease_until
    await queryRunner.query(`
      CREATE INDEX idx_jobs_stale_claims
        ON public.jobs(lease_until)
        WHERE status = 'claimed';
    `);

    // updated_at column is intentionally absent — jobs are high-churn and
    // audit is handled via audit_events with job_id in details when needed.

    // ========================================================================
    // quota_usage_global
    // ========================================================================
    // Two separate tables (not one with nullable project_id) so the PK is
    // clean and indexable. Reviewed per round 1 feedback on Fas 0.2+.
    await queryRunner.query(`
      CREATE TABLE public.quota_usage_global (
        period_key   varchar(32) NOT NULL,
        metric       varchar(64) NOT NULL,
        limit_value  bigint NOT NULL,
        used_value   bigint NOT NULL DEFAULT 0,
        updated_at   timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (period_key, metric),
        CONSTRAINT quota_usage_global_period_nonempty CHECK (char_length(period_key) > 0),
        CONSTRAINT quota_usage_global_metric_nonempty CHECK (char_length(metric) > 0),
        CONSTRAINT quota_usage_global_limit_nonneg CHECK (limit_value >= 0),
        CONSTRAINT quota_usage_global_used_nonneg CHECK (used_value >= 0),
        CONSTRAINT quota_usage_global_used_within_limit CHECK (used_value <= limit_value)
      );
    `);

    // ========================================================================
    // quota_usage_project
    // ========================================================================
    await queryRunner.query(`
      CREATE TABLE public.quota_usage_project (
        period_key   varchar(32) NOT NULL,
        project_id   uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
        metric       varchar(64) NOT NULL,
        limit_value  bigint NOT NULL,
        used_value   bigint NOT NULL DEFAULT 0,
        updated_at   timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (period_key, project_id, metric),
        CONSTRAINT quota_usage_project_period_nonempty CHECK (char_length(period_key) > 0),
        CONSTRAINT quota_usage_project_metric_nonempty CHECK (char_length(metric) > 0),
        CONSTRAINT quota_usage_project_limit_nonneg CHECK (limit_value >= 0),
        CONSTRAINT quota_usage_project_used_nonneg CHECK (used_value >= 0),
        CONSTRAINT quota_usage_project_used_within_limit CHECK (used_value <= limit_value)
      );
    `);

    // Index on project_id for efficient ON DELETE CASCADE from projects.
    // The PK (period_key, project_id, metric) does not support a project_id-
    // leading lookup, so the cascade would otherwise scan the whole table.
    await queryRunner.query(`
      CREATE INDEX idx_quota_usage_project_project_id
        ON public.quota_usage_project(project_id);
    `);

    // ========================================================================
    // reserve_quota(period_key, metric, delta, project_id)
    // ========================================================================
    // Atomic reservation. Returns the NEW used_value (bigint) if the
    // reservation fit within limit_value, or NULL if the reservation would
    // exceed the limit or the quota row does not exist (caller must abort
    // the API call).
    //
    // The CHECK constraint `used_value <= limit_value` is the DB-level
    // backstop, but the WHERE clause here is what makes the reservation
    // atomic and non-blocking. A concurrent caller that attempts the same
    // reservation sees the updated used_value and may be rejected.
    //
    // If the row does not exist, reservation fails (NULL). Callers must
    // pre-seed limit rows via administrative procedure (not in this migration).
    //
    // p_project_id = NULL → global quota; NOT NULL → project quota.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.reserve_quota(
        p_period_key  varchar(32),
        p_metric      varchar(64),
        p_delta       bigint,
        p_project_id  uuid DEFAULT NULL
      ) RETURNS bigint
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_new_used bigint;
      BEGIN
        IF p_period_key IS NULL OR p_metric IS NULL OR p_delta IS NULL THEN
          RAISE EXCEPTION 'reserve_quota: period_key, metric, and delta are required';
        END IF;
        IF char_length(p_period_key) = 0 OR char_length(p_metric) = 0 THEN
          RAISE EXCEPTION 'reserve_quota: period_key and metric must be non-empty';
        END IF;
        IF p_delta <= 0 THEN
          RAISE EXCEPTION 'reserve_quota: delta must be positive (got %)', p_delta;
        END IF;

        IF p_project_id IS NULL THEN
          UPDATE public.quota_usage_global
             SET used_value = public.quota_usage_global.used_value + p_delta,
                 updated_at = now()
           WHERE period_key = p_period_key
             AND metric     = p_metric
             AND public.quota_usage_global.used_value + p_delta <= public.quota_usage_global.limit_value
          RETURNING used_value INTO v_new_used;
        ELSE
          UPDATE public.quota_usage_project
             SET used_value = public.quota_usage_project.used_value + p_delta,
                 updated_at = now()
           WHERE period_key = p_period_key
             AND project_id = p_project_id
             AND metric     = p_metric
             AND public.quota_usage_project.used_value + p_delta <= public.quota_usage_project.limit_value
          RETURNING used_value INTO v_new_used;
        END IF;

        RETURN v_new_used;  -- NULL if would exceed limit or row absent
      END;
      $fn$;
    `);

    await queryRunner.query(`
      REVOKE ALL ON FUNCTION public.reserve_quota(varchar, varchar, bigint, uuid) FROM PUBLIC;
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.reserve_quota(varchar, varchar, bigint, uuid) TO devloop_api;
    `);

    // ========================================================================
    // reconcile_quota(period_key, metric, actual, reserved, project_id)
    // ========================================================================
    // Post-call adjustment when actual usage differs from reserved. Always
    // applies the delta (actual - reserved); can be negative if actual was
    // lower than reserved (refund). Returns the adjusted used_value.
    //
    // This is NOT rejected on CHECK violation because the CHECK
    // (used_value <= limit_value) might have been true before the
    // reconciliation but false after if the actual exceeded the limit.
    // The caller is expected to have already paid for the API call;
    // reconciliation just records the truth. If it would put the row
    // over the limit, we clamp to limit_value and emit an audit event.
    //
    // In practice, reservation is conservative (estimated high) and
    // reconciliation usually adjusts down. Going over should be rare.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.reconcile_quota(
        p_period_key  varchar(32),
        p_metric      varchar(64),
        p_actual      bigint,
        p_reserved    bigint,
        p_project_id  uuid DEFAULT NULL
      ) RETURNS bigint
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_delta      bigint;
        v_old_used   bigint;
        v_new_used   bigint;
        v_limit      bigint;
        v_unclamped  bigint;
        v_was_clamped boolean;
      BEGIN
        IF p_period_key IS NULL OR p_metric IS NULL
           OR p_actual IS NULL OR p_reserved IS NULL THEN
          RAISE EXCEPTION 'reconcile_quota: all value arguments required';
        END IF;
        IF char_length(p_period_key) = 0 OR char_length(p_metric) = 0 THEN
          RAISE EXCEPTION 'reconcile_quota: period_key and metric must be non-empty';
        END IF;
        IF p_actual < 0 OR p_reserved < 0 THEN
          RAISE EXCEPTION 'reconcile_quota: actual and reserved must be non-negative';
        END IF;

        v_delta := p_actual - p_reserved;

        IF p_project_id IS NULL THEN
          SELECT limit_value, used_value INTO v_limit, v_old_used
            FROM public.quota_usage_global
           WHERE period_key = p_period_key AND metric = p_metric
             FOR UPDATE;

          IF NOT FOUND THEN
            RAISE EXCEPTION 'reconcile_quota: quota row not found for (%, %, global)',
              p_period_key, p_metric;
          END IF;

          v_unclamped := v_old_used + v_delta;
          v_was_clamped := (v_unclamped > v_limit) OR (v_unclamped < 0);

          -- Even on no-op (delta=0) we return the current used_value for
          -- contract consistency; short-circuit the UPDATE to avoid an
          -- unnecessary row rewrite.
          IF v_delta = 0 THEN
            RETURN v_old_used;
          END IF;

          UPDATE public.quota_usage_global
             SET used_value = GREATEST(0, LEAST(v_unclamped, v_limit)),
                 updated_at = now()
           WHERE period_key = p_period_key AND metric = p_metric
          RETURNING used_value INTO v_new_used;
        ELSE
          SELECT limit_value, used_value INTO v_limit, v_old_used
            FROM public.quota_usage_project
           WHERE period_key = p_period_key AND project_id = p_project_id AND metric = p_metric
             FOR UPDATE;

          IF NOT FOUND THEN
            RAISE EXCEPTION 'reconcile_quota: quota row not found for (%, %, %)',
              p_period_key, p_metric, p_project_id;
          END IF;

          v_unclamped := v_old_used + v_delta;
          v_was_clamped := (v_unclamped > v_limit) OR (v_unclamped < 0);

          IF v_delta = 0 THEN
            RETURN v_old_used;
          END IF;

          UPDATE public.quota_usage_project
             SET used_value = GREATEST(0, LEAST(v_unclamped, v_limit)),
                 updated_at = now()
           WHERE period_key = p_period_key
             AND project_id = p_project_id
             AND metric = p_metric
          RETURNING used_value INTO v_new_used;
        END IF;

        -- Audit only when we actually had to clamp (unclamped > limit or < 0).
        -- Previous logic triggered on "landed on exact limit" which is a
        -- false positive.
        IF v_was_clamped THEN
          PERFORM public.append_audit_event(
            p_project_id, NULL::uuid, NULL::uuid,
            'review_quota_exceeded'::public.audit_event_enum,
            'system'::public.actor_kind_enum,
            'reconcile_quota',
            jsonb_build_object(
              'period_key',      p_period_key,
              'metric',          p_metric,
              'actual',          p_actual,
              'reserved',        p_reserved,
              'unclamped_target', v_unclamped,
              'limit',           v_limit,
              'clamped_to',      v_new_used
            ),
            NULL::varchar(32), NULL::varchar(32), NULL::varchar(64), NULL::varchar(32)
          );
        END IF;

        RETURN v_new_used;
      END;
      $fn$;
    `);

    await queryRunner.query(`
      REVOKE ALL ON FUNCTION public.reconcile_quota(varchar, varchar, bigint, bigint, uuid) FROM PUBLIC;
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.reconcile_quota(varchar, varchar, bigint, bigint, uuid) TO devloop_api;
    `);

    // ========================================================================
    // Grants for jobs and quota tables
    // ========================================================================
    // jobs: SELECT/INSERT/UPDATE granted directly because the dequeue path
    // is hot and going through a stored procedure would add overhead without
    // a clear security win (the rows are not sensitive — they're work items).
    // Consumers still use fenced UPDATE patterns to claim and complete.
    await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON public.jobs TO devloop_api;`);
    await queryRunner.query(`GRANT USAGE ON SEQUENCE public.jobs_id_seq TO devloop_api;`);

    // quota_usage_*: SELECT only. All mutations via reserve_quota/reconcile_quota.
    await queryRunner.query(`GRANT SELECT ON public.quota_usage_global TO devloop_api;`);
    await queryRunner.query(`GRANT SELECT ON public.quota_usage_project TO devloop_api;`);

    // Defense-in-depth REVOKE from PUBLIC on new tables
    await queryRunner.query(`REVOKE ALL ON public.jobs FROM PUBLIC;`);
    await queryRunner.query(`REVOKE ALL ON public.quota_usage_global FROM PUBLIC;`);
    await queryRunner.query(`REVOKE ALL ON public.quota_usage_project FROM PUBLIC;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.reconcile_quota(varchar, varchar, bigint, bigint, uuid);
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.reserve_quota(varchar, varchar, bigint, uuid);
    `);

    await queryRunner.query(`REVOKE ALL ON public.quota_usage_project FROM devloop_api;`);
    await queryRunner.query(`REVOKE ALL ON public.quota_usage_global FROM devloop_api;`);
    await queryRunner.query(`REVOKE ALL ON public.jobs FROM devloop_api;`);

    await queryRunner.query(`DROP TABLE IF EXISTS public.quota_usage_project;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.quota_usage_global;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.jobs;`);
  }
}
