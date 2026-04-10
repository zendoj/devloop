import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 007 — deploy-path tables + host apply lifecycle procedures.
 *
 * Scope (Fas 0.7):
 *   - public.project_configs: per-project versioned classifier / agent
 *     roles / build commands config per ARCHITECTURE.md §4.2. At most
 *     one active version per project is enforced by a partial unique
 *     index; zero active is a valid transient state during activation
 *     rotation, which is always wrapped in a single transaction so
 *     concurrent readers never observe the zero-active window under MVCC.
 *   - public.signing_keys: Ed25519 public keys (PUBLIC PART ONLY; private
 *     keys live in /etc/devloop/deploy_signing_priv_<key_id> on disk per
 *     §4.3 and §19 D9). At most one row with status='active' enforced by
 *     a partial unique index; two-phase rotation inside a single
 *     transaction preserves the steady-state "exactly one" invariant.
 *   - public.desired_state_history: append-only pull-based deploy intent
 *     history (§4.2). Contains signed_bytes (verbatim JCS bytes from
 *     §19 D8) and signature (Ed25519). Has lifecycle fields for host
 *     apply progress: apply_started_at, apply_last_heartbeat_at,
 *     applied_sha, applied_at, applied_status.
 *   - FK additions on agent_tasks:
 *       project_config_id          → project_configs(id) RESTRICT
 *       applied_desired_state_id   → desired_state_history(id) RESTRICT
 *       rollback_desired_state_id  → desired_state_history(id) RESTRICT
 *   - Stored procedures for host apply lifecycle:
 *       record_desired_state: inserts new history row with caller-supplied
 *         signed_bytes + signature (signing happens in deployer worker
 *         with the private key from disk, never in DB)
 *       record_apply_started: marks apply_started_at on a row
 *       record_apply_heartbeat: bumps apply_last_heartbeat_at
 *       record_deploy_applied: records final success/failed with
 *         applied_status IS NULL gate (§10 late-success protection)
 *       record_apply_timeout: sets applied_status='timed_out' so late
 *         success reports are rejected (called by verification scanner)
 *
 * Deferred to Fas 0.8+:
 *   - host_health + host_health_alerts
 *   - branch_protection_checks
 *   - Auth implementation
 *   - NestJS TypeORM wiring
 */
export class DeployPathTables1712700000007 implements MigrationInterface {
  name = 'DeployPathTables1712700000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ========================================================================
    // project_configs
    // ========================================================================
    await queryRunner.query(`
      CREATE TABLE public.project_configs (
        id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id              uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
        version_seq             bigint NOT NULL,
        is_active               boolean NOT NULL DEFAULT false,
        classifier_rules        jsonb NOT NULL,
        agent_roles             jsonb NOT NULL,
        build_commands          jsonb NOT NULL,
        branch_naming_pattern   varchar(255) NOT NULL DEFAULT 'devloop/task/{task_id}',
        allowed_modules         text[] NOT NULL DEFAULT '{}',
        locked_modules          text[] NOT NULL DEFAULT '{}',
        created_at              timestamptz NOT NULL DEFAULT now(),
        created_by              uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
        UNIQUE (project_id, version_seq),
        CONSTRAINT project_configs_version_seq_positive CHECK (version_seq > 0),
        CONSTRAINT project_configs_branch_naming_nonempty CHECK (char_length(branch_naming_pattern) > 0)
      );
    `);

    // At most one active config per project (partial unique index). The
    // partial UNIQUE enforces the "no two actives" invariant but does not
    // require at least one — zero active is a valid intermediate state.
    // Activation is a two-phase operation (set old is_active=false, then
    // set new is_active=true) and MUST be done in a single transaction so
    // concurrent readers never observe the zero-active window under MVCC.
    // The spec language "exactly one" refers to steady state, not the
    // bootstrap/rotation window.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_project_configs_one_active_per_project
        ON public.project_configs(project_id)
        WHERE is_active = true;
    `);

    // FK support index for cascade delete from projects
    await queryRunner.query(`
      CREATE INDEX idx_project_configs_project_id ON public.project_configs(project_id);
    `);

    // ========================================================================
    // signing_keys
    // ========================================================================
    // PUBLIC KEYS ONLY. Private keys live at:
    //   /etc/devloop/deploy_signing_priv_<key_id>
    // loaded via systemd LoadCredential per §4.3 and §19 D9.
    await queryRunner.query(`
      CREATE TABLE public.signing_keys (
        key_id      varchar(64) PRIMARY KEY,
        algorithm   public.signing_algorithm_enum NOT NULL DEFAULT 'ed25519',
        public_key  bytea NOT NULL,
        status      public.signing_key_status_enum NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        retired_at  timestamptz NULL,
        CONSTRAINT signing_keys_key_id_nonempty CHECK (char_length(key_id) > 0),
        CONSTRAINT signing_keys_public_key_length CHECK (
          -- Ed25519 public keys are exactly 32 bytes
          algorithm <> 'ed25519' OR octet_length(public_key) = 32
        ),
        CONSTRAINT signing_keys_retired_at_consistency CHECK (
          (status = 'retired' AND retired_at IS NOT NULL)
          OR (status <> 'retired' AND retired_at IS NULL)
        )
      );
    `);

    // At most one active signing key at a time (§19 D9 steady state).
    // Partial unique index on a constant expression (TRUE) where
    // status='active' enforces "no two actives" but allows zero active
    // during the rotation window. Rotation is a two-phase admin operation
    // (retire the old key, insert the new one as active) wrapped in a
    // single transaction to hide the zero-active state from runtime
    // readers under MVCC.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_signing_keys_one_active
        ON public.signing_keys((true))
        WHERE status = 'active';
    `);

    // ========================================================================
    // desired_state_history
    // ========================================================================
    // Append-only (for create). Update allowed only on apply_* columns via
    // record_deploy_applied / record_apply_* stored procedures.
    //
    // signed_bytes contains the exact RFC 8785 JCS-canonicalized bytes that
    // were signed. Host verifies against these verbatim. Signing happens in
    // the deployer worker using the private key file on disk; the DB only
    // stores already-signed bytes. See §19 D8.
    await queryRunner.query(`
      CREATE TABLE public.desired_state_history (
        id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id              uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
        seq_no                  bigint NOT NULL,
        deploy_sha              varchar(64) NOT NULL,
        base_sha                varchar(64) NOT NULL,
        action                  public.desired_action_enum NOT NULL,
        target_branch           varchar(128) NOT NULL,
        signing_key_id          varchar(64) NOT NULL REFERENCES public.signing_keys(key_id) ON DELETE RESTRICT,
        signed_bytes            bytea NOT NULL,
        signature               bytea NOT NULL,
        issued_at               timestamptz NOT NULL DEFAULT now(),
        issued_by_task_id       uuid NULL REFERENCES public.agent_tasks(id) ON DELETE RESTRICT,
        issued_by_user_id       uuid NULL REFERENCES public.users(id) ON DELETE RESTRICT,

        -- Host apply lifecycle fields (v9 / Fas 0.7)
        apply_started_at        timestamptz NULL,
        apply_last_heartbeat_at timestamptz NULL,
        applied_sha             varchar(64) NULL,
        applied_at              timestamptz NULL,
        applied_status          public.apply_status_enum NULL,
        applied_log_excerpt     text NULL,

        UNIQUE (project_id, seq_no),
        CONSTRAINT desired_state_history_seq_no_positive CHECK (seq_no > 0),
        CONSTRAINT desired_state_history_deploy_sha_nonempty CHECK (char_length(deploy_sha) > 0),
        CONSTRAINT desired_state_history_base_sha_nonempty CHECK (char_length(base_sha) > 0),
        CONSTRAINT desired_state_history_target_branch_nonempty CHECK (char_length(target_branch) > 0),
        CONSTRAINT desired_state_history_ed25519_signature_length CHECK (
          octet_length(signature) = 64
        ),
        CONSTRAINT desired_state_history_signed_bytes_nonempty CHECK (
          octet_length(signed_bytes) > 0
        ),
        CONSTRAINT desired_state_history_applied_consistency CHECK (
          -- success must have applied_sha + applied_at
          (applied_status <> 'success' OR applied_status IS NULL)
          OR (applied_sha IS NOT NULL AND applied_at IS NOT NULL)
        ),
        -- Only success may record an applied_sha. Non-success (failed,
        -- timed_out) must leave applied_sha NULL so inspectors can't be
        -- misled by a stale sha on a failed apply. Also rejects empty
        -- string on success so callers can't slip a blank past the
        -- proc-level NULL guard.
        CONSTRAINT desired_state_history_applied_sha_only_on_success CHECK (
          (applied_sha IS NULL AND applied_status IS DISTINCT FROM 'success')
          OR (applied_status = 'success' AND char_length(applied_sha) > 0)
        ),
        -- Baseline seeding (project registration): both issuer fields NULL.
        -- Non-baseline: exactly one of issued_by_task_id / issued_by_user_id set.
        CONSTRAINT desired_state_history_issuer_xor CHECK (
          (action = 'baseline'
           AND issued_by_task_id IS NULL
           AND issued_by_user_id IS NULL)
          OR
          (action <> 'baseline'
           AND (
             (issued_by_task_id IS NOT NULL AND issued_by_user_id IS NULL)
             OR
             (issued_by_task_id IS NULL AND issued_by_user_id IS NOT NULL)
           ))
        )
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_desired_state_history_project_seq
        ON public.desired_state_history(project_id, seq_no DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX idx_desired_state_history_issued_by_task
        ON public.desired_state_history(issued_by_task_id)
        WHERE issued_by_task_id IS NOT NULL;
    `);

    // ========================================================================
    // FK additions to agent_tasks for columns added in migration 004
    // ========================================================================
    // migration 004 declared these as nullable uuid without FK because the
    // target tables didn't exist yet. Now they do.
    await queryRunner.query(`
      ALTER TABLE public.agent_tasks
        ADD CONSTRAINT agent_tasks_project_config_id_fkey
        FOREIGN KEY (project_config_id) REFERENCES public.project_configs(id) ON DELETE RESTRICT;
    `);
    await queryRunner.query(`
      ALTER TABLE public.agent_tasks
        ADD CONSTRAINT agent_tasks_applied_desired_state_id_fkey
        FOREIGN KEY (applied_desired_state_id) REFERENCES public.desired_state_history(id) ON DELETE RESTRICT;
    `);
    await queryRunner.query(`
      ALTER TABLE public.agent_tasks
        ADD CONSTRAINT agent_tasks_rollback_desired_state_id_fkey
        FOREIGN KEY (rollback_desired_state_id) REFERENCES public.desired_state_history(id) ON DELETE RESTRICT;
    `);

    // FK support indexes for the new columns
    await queryRunner.query(`
      CREATE INDEX idx_agent_tasks_project_config_id
        ON public.agent_tasks(project_config_id)
        WHERE project_config_id IS NOT NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX idx_agent_tasks_applied_desired_state_id
        ON public.agent_tasks(applied_desired_state_id)
        WHERE applied_desired_state_id IS NOT NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX idx_agent_tasks_rollback_desired_state_id
        ON public.agent_tasks(rollback_desired_state_id)
        WHERE rollback_desired_state_id IS NOT NULL;
    `);

    // ========================================================================
    // record_desired_state() — insert signed desired state row
    // ========================================================================
    // Caller (deployer worker) provides already-signed bytes and signature.
    // Signing happens in the deployer process using the private key from
    // disk; the DB never holds or handles private key material.
    //
    // Assigns the next seq_no atomically per project. Returns the new row's id.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.record_desired_state(
        p_project_id          uuid,
        p_deploy_sha          varchar(64),
        p_base_sha            varchar(64),
        p_action              public.desired_action_enum,
        p_target_branch       varchar(128),
        p_signing_key_id      varchar(64),
        p_signed_bytes        bytea,
        p_signature           bytea,
        p_issued_by_task_id   uuid DEFAULT NULL,
        p_issued_by_user_id   uuid DEFAULT NULL
      ) RETURNS uuid
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_next_seq bigint;
        v_new_id   uuid;
      BEGIN
        IF p_project_id IS NULL OR p_deploy_sha IS NULL OR p_base_sha IS NULL
           OR p_action IS NULL OR p_target_branch IS NULL OR p_signing_key_id IS NULL
           OR p_signed_bytes IS NULL OR p_signature IS NULL THEN
          RAISE EXCEPTION 'record_desired_state: all required args must be non-null';
        END IF;

        -- Signing-key freshness gate: new desired state may only be
        -- signed with the currently active key. Historical rows keep
        -- their original signing_key_id (FK is RESTRICT, retired keys
        -- stay in the table for verification), but new issuance is
        -- locked to whatever key is active right now. Belt-and-suspenders
        -- against the deployer worker signing with a stale on-disk key
        -- after rotation.
        --
        -- FOR KEY SHARE locks the key row so a concurrent rotation
        -- transaction that flips status to 'retired' is blocked until
        -- this insert commits, closing the TOCTOU window between the
        -- check and the INSERT below.
        PERFORM 1
           FROM public.signing_keys
          WHERE key_id = p_signing_key_id
            AND status = 'active'
          FOR KEY SHARE;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'record_desired_state: signing_key_id % is not the currently active key', p_signing_key_id;
        END IF;

        -- Atomic next seq_no: max + 1 per project. Serialize concurrent
        -- callers for THIS project with a transaction-scoped advisory lock.
        -- The (int, int) form namespaces the lock with a class key derived
        -- from the function name so we don't collide with unrelated callers
        -- that might hash a project_id for their own purposes. Released
        -- automatically on COMMIT/ROLLBACK. PG's UNIQUE (project_id, seq_no)
        -- index is the hard backstop if two callers somehow both compute
        -- the same seq_no.
        --
        -- (FOR UPDATE cannot be combined with aggregate functions in the
        -- same SELECT, which is why we use an advisory lock instead of a
        -- row lock on desired_state_history.)
        PERFORM pg_advisory_xact_lock(
          hashtext('record_desired_state'),
          hashtext(p_project_id::text)
        );

        SELECT COALESCE(MAX(seq_no), 0) + 1 INTO v_next_seq
          FROM public.desired_state_history
         WHERE project_id = p_project_id;

        INSERT INTO public.desired_state_history (
          project_id, seq_no, deploy_sha, base_sha, action, target_branch,
          signing_key_id, signed_bytes, signature,
          issued_by_task_id, issued_by_user_id
        ) VALUES (
          p_project_id, v_next_seq, p_deploy_sha, p_base_sha, p_action, p_target_branch,
          p_signing_key_id, p_signed_bytes, p_signature,
          p_issued_by_task_id, p_issued_by_user_id
        )
        RETURNING id INTO v_new_id;

        PERFORM public.append_audit_event(
          p_project_id, p_issued_by_task_id, NULL::uuid,
          'deploy_desired_state_written'::public.audit_event_enum,
          CASE WHEN p_issued_by_user_id IS NOT NULL
               THEN 'user'::public.actor_kind_enum
               ELSE 'system'::public.actor_kind_enum
          END,
          'record_desired_state',
          jsonb_build_object(
            'seq_no',         v_next_seq,
            'action',         p_action::text,
            'deploy_sha',     p_deploy_sha,
            'signing_key_id', p_signing_key_id
          ),
          NULL::varchar(32), NULL::varchar(32), p_deploy_sha, NULL::varchar(32)
        );

        RETURN v_new_id;
      END;
      $fn$;
    `);

    // ========================================================================
    // record_apply_started(desired_state_id, project_id)
    // ========================================================================
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.record_apply_started(
        p_desired_state_id  uuid,
        p_project_id        uuid
      ) RETURNS boolean
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_was_first_start  boolean;
      BEGIN
        IF p_desired_state_id IS NULL OR p_project_id IS NULL THEN
          RAISE EXCEPTION 'record_apply_started: required args missing';
        END IF;

        -- Row-lock the target row and capture whether apply_started_at
        -- was previously NULL. This lets us emit the
        -- deploy_host_apply_started audit event exactly once across
        -- retries (true idempotency per review feedback).
        SELECT (apply_started_at IS NULL)
          INTO v_was_first_start
          FROM public.desired_state_history
         WHERE id             = p_desired_state_id
           AND project_id     = p_project_id
           AND applied_status IS NULL
         FOR UPDATE;

        IF NOT FOUND THEN RETURN false; END IF;

        UPDATE public.desired_state_history
           SET apply_started_at        = COALESCE(apply_started_at, now()),
               apply_last_heartbeat_at = now()
         WHERE id         = p_desired_state_id
           AND project_id = p_project_id;

        IF v_was_first_start THEN
          PERFORM public.append_audit_event(
            p_project_id, NULL::uuid, NULL::uuid,
            'deploy_host_apply_started'::public.audit_event_enum,
            'system'::public.actor_kind_enum,
            'host-deploy-agent',
            jsonb_build_object('desired_state_id', p_desired_state_id),
            NULL::varchar(32), NULL::varchar(32), NULL::varchar(64), NULL::varchar(32)
          );
        END IF;
        RETURN true;
      END;
      $fn$;
    `);

    // ========================================================================
    // record_apply_heartbeat(desired_state_id, project_id)
    // ========================================================================
    // Best-effort heartbeat. Does NOT emit audit on every call (too noisy);
    // only heartbeat frequency is visible via apply_last_heartbeat_at.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.record_apply_heartbeat(
        p_desired_state_id  uuid,
        p_project_id        uuid
      ) RETURNS boolean
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_updated integer;
      BEGIN
        IF p_desired_state_id IS NULL OR p_project_id IS NULL THEN
          RAISE EXCEPTION 'record_apply_heartbeat: required args missing';
        END IF;

        -- Heartbeat is only valid after the apply has been started.
        -- Gating on apply_started_at IS NOT NULL prevents a caller from
        -- keeping a never-started row alive with heartbeats and keeps
        -- timeout semantics unambiguous.
        UPDATE public.desired_state_history
           SET apply_last_heartbeat_at = now()
         WHERE id                = p_desired_state_id
           AND project_id        = p_project_id
           AND applied_status    IS NULL
           AND apply_started_at  IS NOT NULL;

        GET DIAGNOSTICS v_updated = ROW_COUNT;
        RETURN v_updated > 0;
      END;
      $fn$;
    `);

    // ========================================================================
    // record_deploy_applied(desired_state_id, project_id, status, sha, log)
    // ========================================================================
    // Final success/failed callback. Gates on applied_status IS NULL — so
    // if record_apply_timeout has already marked the row as 'timed_out',
    // a late success is rejected (v10 / §10 late-success protection).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.record_deploy_applied(
        p_desired_state_id uuid,
        p_project_id       uuid,
        p_status           public.apply_status_enum,
        p_applied_sha      varchar(64),
        p_log_excerpt      text
      ) RETURNS boolean
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_updated integer;
      BEGIN
        IF p_desired_state_id IS NULL OR p_project_id IS NULL THEN
          RAISE EXCEPTION 'record_deploy_applied: desired_state_id and project_id required';
        END IF;
        -- NULL guard BEFORE the IN-check: SQL NULL NOT IN (...) evaluates
        -- to NULL, not true, so a NULL p_status would otherwise slip past
        -- the validation and corrupt applied_status.
        IF p_status IS NULL THEN
          RAISE EXCEPTION 'record_deploy_applied: p_status cannot be NULL';
        END IF;
        IF p_status NOT IN ('success', 'failed') THEN
          RAISE EXCEPTION 'record_deploy_applied: status must be success or failed (got %)', p_status;
        END IF;
        IF p_status = 'success' AND p_applied_sha IS NULL THEN
          RAISE EXCEPTION 'record_deploy_applied: success requires non-null applied_sha';
        END IF;

        -- Non-success must never carry applied_sha (enforced by table CHECK
        -- too, but normalize here so callers can't force the row into a
        -- rejected state via CHECK violation).
        IF p_status <> 'success' THEN
          p_applied_sha := NULL;
        END IF;

        UPDATE public.desired_state_history
           SET applied_sha          = p_applied_sha,
               applied_at           = now(),
               applied_status       = p_status,
               applied_log_excerpt  = p_log_excerpt
         WHERE id             = p_desired_state_id
           AND project_id     = p_project_id
           AND applied_status IS NULL;

        GET DIAGNOSTICS v_updated = ROW_COUNT;

        IF v_updated = 0 THEN
          -- Distinguish late-after-timeout from duplicate/missing
          IF EXISTS (
            SELECT 1 FROM public.desired_state_history
             WHERE id = p_desired_state_id
               AND project_id = p_project_id
               AND applied_status = 'timed_out'
          ) THEN
            PERFORM public.append_audit_event(
              p_project_id, NULL::uuid, NULL::uuid,
              'deploy_host_apply_late_after_timeout'::public.audit_event_enum,
              'system'::public.actor_kind_enum,
              'host-deploy-agent',
              jsonb_build_object(
                'desired_state_id', p_desired_state_id,
                'attempted_status', p_status::text
              ),
              NULL::varchar(32), NULL::varchar(32), NULL::varchar(64), NULL::varchar(32)
            );
          ELSE
            PERFORM public.append_audit_event(
              p_project_id, NULL::uuid, NULL::uuid,
              'deploy_host_apply_duplicate_or_missing'::public.audit_event_enum,
              'system'::public.actor_kind_enum,
              'host-deploy-agent',
              jsonb_build_object(
                'desired_state_id', p_desired_state_id,
                'attempted_status', p_status::text
              ),
              NULL::varchar(32), NULL::varchar(32), NULL::varchar(64), NULL::varchar(32)
            );
          END IF;
          RETURN false;
        END IF;

        PERFORM public.append_audit_event(
          p_project_id, NULL::uuid, NULL::uuid,
          CASE WHEN p_status = 'success'
               THEN 'deploy_host_applied'::public.audit_event_enum
               ELSE 'deploy_host_apply_failed'::public.audit_event_enum
          END,
          'system'::public.actor_kind_enum,
          'host-deploy-agent',
          jsonb_build_object(
            'desired_state_id', p_desired_state_id,
            'applied_sha',      p_applied_sha,
            'status',           p_status::text
          ),
          NULL::varchar(32), NULL::varchar(32), p_applied_sha, NULL::varchar(32)
        );
        RETURN true;
      END;
      $fn$;
    `);

    // ========================================================================
    // record_apply_timeout(desired_state_id, project_id, reason)
    // ========================================================================
    // Called by the verification scanner (running inside the deployer worker)
    // when heartbeat staleness or total timeout is detected. Marks the row
    // 'timed_out' before any rollback flow begins. Idempotent: if already
    // timed_out or finalized, returns false.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.record_apply_timeout(
        p_desired_state_id uuid,
        p_project_id       uuid,
        p_reason           varchar(64)
      ) RETURNS boolean
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_updated integer;
      BEGIN
        IF p_desired_state_id IS NULL OR p_project_id IS NULL OR p_reason IS NULL THEN
          RAISE EXCEPTION 'record_apply_timeout: required args missing';
        END IF;
        -- Constrain p_reason to the known set so audit semantics stay
        -- tight. Extend this list (and the CASE in the audit emit below)
        -- in lockstep if new timeout reasons appear.
        IF p_reason NOT IN ('heartbeat_stale', 'total_timeout') THEN
          RAISE EXCEPTION 'record_apply_timeout: p_reason must be heartbeat_stale or total_timeout (got %)', p_reason;
        END IF;

        UPDATE public.desired_state_history
           SET applied_status = 'timed_out',
               applied_at     = now(),
               applied_log_excerpt = concat('timeout: ', p_reason)
         WHERE id             = p_desired_state_id
           AND project_id     = p_project_id
           AND applied_status IS NULL;

        GET DIAGNOSTICS v_updated = ROW_COUNT;
        IF v_updated = 0 THEN RETURN false; END IF;

        PERFORM public.append_audit_event(
          p_project_id, NULL::uuid, NULL::uuid,
          CASE WHEN p_reason = 'heartbeat_stale'
               THEN 'host_heartbeat_timeout'::public.audit_event_enum
               ELSE 'host_apply_timeout'::public.audit_event_enum
          END,
          'system'::public.actor_kind_enum,
          'deployer-verification-scanner',
          jsonb_build_object(
            'desired_state_id', p_desired_state_id,
            'reason',           p_reason
          ),
          NULL::varchar(32), NULL::varchar(32), NULL::varchar(64), NULL::varchar(32)
        );
        RETURN true;
      END;
      $fn$;
    `);

    // ========================================================================
    // Grants
    // ========================================================================
    // project_configs: SELECT + INSERT + UPDATE on is_active (for activation
    // flows). Creation is via admin UI; direct INSERT is granted but the
    // partial unique index enforces invariants.
    await queryRunner.query(`GRANT SELECT, INSERT ON public.project_configs TO devloop_api;`);
    await queryRunner.query(`GRANT UPDATE (is_active) ON public.project_configs TO devloop_api;`);

    // signing_keys: SELECT only on public_key and metadata. Rotation happens
    // via direct INSERT/UPDATE from a future admin migration, never runtime.
    await queryRunner.query(`GRANT SELECT ON public.signing_keys TO devloop_api;`);

    // desired_state_history: SELECT + EXECUTE on the 5 procedures.
    // No direct INSERT/UPDATE grant.
    await queryRunner.query(`GRANT SELECT ON public.desired_state_history TO devloop_api;`);
    await queryRunner.query(`
      REVOKE ALL ON FUNCTION public.record_desired_state(uuid, varchar, varchar, public.desired_action_enum, varchar, varchar, bytea, bytea, uuid, uuid) FROM PUBLIC;
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.record_desired_state(uuid, varchar, varchar, public.desired_action_enum, varchar, varchar, bytea, bytea, uuid, uuid) TO devloop_api;
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION public.record_apply_started(uuid, uuid) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION public.record_apply_started(uuid, uuid) TO devloop_api;`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION public.record_apply_heartbeat(uuid, uuid) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION public.record_apply_heartbeat(uuid, uuid) TO devloop_api;`);
    await queryRunner.query(`
      REVOKE ALL ON FUNCTION public.record_deploy_applied(uuid, uuid, public.apply_status_enum, varchar, text) FROM PUBLIC;
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.record_deploy_applied(uuid, uuid, public.apply_status_enum, varchar, text) TO devloop_api;
    `);
    await queryRunner.query(`REVOKE ALL ON FUNCTION public.record_apply_timeout(uuid, uuid, varchar) FROM PUBLIC;`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION public.record_apply_timeout(uuid, uuid, varchar) TO devloop_api;`);

    // Defense-in-depth REVOKE from PUBLIC
    await queryRunner.query(`REVOKE ALL ON public.project_configs FROM PUBLIC;`);
    await queryRunner.query(`REVOKE ALL ON public.signing_keys FROM PUBLIC;`);
    await queryRunner.query(`REVOKE ALL ON public.desired_state_history FROM PUBLIC;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop procedures
    await queryRunner.query(`DROP FUNCTION IF EXISTS public.record_apply_timeout(uuid, uuid, varchar);`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS public.record_deploy_applied(uuid, uuid, public.apply_status_enum, varchar, text);`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS public.record_apply_heartbeat(uuid, uuid);`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS public.record_apply_started(uuid, uuid);`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS public.record_desired_state(uuid, varchar, varchar, public.desired_action_enum, varchar, varchar, bytea, bytea, uuid, uuid);`);

    // Drop FKs from agent_tasks
    await queryRunner.query(`ALTER TABLE public.agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_rollback_desired_state_id_fkey;`);
    await queryRunner.query(`ALTER TABLE public.agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_applied_desired_state_id_fkey;`);
    await queryRunner.query(`ALTER TABLE public.agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_project_config_id_fkey;`);

    // Drop FK support indexes
    await queryRunner.query(`DROP INDEX IF EXISTS public.idx_agent_tasks_rollback_desired_state_id;`);
    await queryRunner.query(`DROP INDEX IF EXISTS public.idx_agent_tasks_applied_desired_state_id;`);
    await queryRunner.query(`DROP INDEX IF EXISTS public.idx_agent_tasks_project_config_id;`);

    // Drop tables in FK-reverse order
    await queryRunner.query(`DROP TABLE IF EXISTS public.desired_state_history;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.signing_keys;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.project_configs;`);
  }
}
