import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 008 — host health + compliance (branch protection).
 *
 * Scope (Fas 0.8):
 *   - public.health_status_enum: new enum ('up','down','degraded').
 *   - public.host_health: append-only probe history per project. Each
 *     row represents a single health probe performed by either the
 *     Public API health-monitor module or the deployer verification
 *     scanner (see §2.1/§2.2 and §7.5 step 9).
 *   - public.host_health_alerts: one row per open alert. Created on
 *     transition into a non-'up' status and resolved (resolved_at set)
 *     on transition back to 'up'. A partial unique index enforces at
 *     most one open alert per project.
 *   - public.branch_protection_checks: compliance check history. Run at
 *     project registration (blocking) and every 6h. Failure sets the
 *     project to status='paused' (application-side, not enforced here)
 *     and emits compliance_check_failed.
 *
 *   - public.record_host_health_probe: single entry point for recording
 *     a probe. Inserts the history row, detects status transitions
 *     against the previous most-recent row, opens/resolves alerts, and
 *     emits the correct audit event (health_up / health_down /
 *     health_degraded). Returns the new probe row id.
 *
 *   - public.acknowledge_host_health_alert: sets acknowledged_at +
 *     acknowledged_by + acknowledgement_note on an open alert. Only
 *     valid while the alert is still open (resolved_at IS NULL).
 *
 *   - public.record_branch_protection_check: inserts the compliance
 *     row and emits compliance_check_passed / compliance_check_failed.
 *
 * Grants per §19 D26 (only devloop_api exists at this phase;
 * devloop_orch/rev/dep/wm grants are added in Fas 0.9+):
 *   - devloop_api: SELECT + INSERT on host_health; SELECT + INSERT +
 *     UPDATE(acknowledged_*) on host_health_alerts; SELECT + INSERT on
 *     branch_protection_checks; EXECUTE on the three procedures.
 *   - Defense-in-depth REVOKE ALL FROM PUBLIC on the new tables and
 *     procedures.
 *
 * Deferred to Fas 0.9+:
 *   - Auth implementation
 *   - NestJS TypeORM wiring for these tables
 *   - Runtime role grants (devloop_orch etc.)
 */
export class HealthAndCompliance1712700000008 implements MigrationInterface {
  name = 'HealthAndCompliance1712700000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ========================================================================
    // health_status_enum
    // ========================================================================
    // Three-state health model matching the health_up / health_down /
    // health_degraded audit events defined in migration 001.
    await queryRunner.query(`
      CREATE TYPE public.health_status_enum AS ENUM ('up', 'down', 'degraded');
    `);

    // ========================================================================
    // host_health — append-only probe history
    // ========================================================================
    // Each row is a single probe result. probe_source distinguishes the
    // Public API health-monitor periodic poll from the deployer's post-
    // apply verification probe (see §7.5 step 9). Both write through the
    // same record_host_health_probe procedure.
    await queryRunner.query(`
      CREATE TABLE public.host_health (
        id             bigserial PRIMARY KEY,
        project_id     uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
        probed_at      timestamptz NOT NULL DEFAULT now(),
        status         public.health_status_enum NOT NULL,
        http_status    int NULL,
        latency_ms     int NULL,
        probe_source   varchar(64) NOT NULL,
        error_message  text NULL,
        CONSTRAINT host_health_probe_source_nonempty CHECK (char_length(btrim(probe_source)) > 0),
        CONSTRAINT host_health_latency_nonneg CHECK (latency_ms IS NULL OR latency_ms >= 0),
        CONSTRAINT host_health_http_status_range CHECK (
          http_status IS NULL OR (http_status >= 100 AND http_status <= 599)
        ),
        -- 'up' implies no error message; a bad status must not silently
        -- carry a mislabeled 'up'. This is a correctness backstop.
        CONSTRAINT host_health_up_has_no_error CHECK (
          status <> 'up' OR error_message IS NULL
        ),
        -- (project_id, id) uniqueness supports composite FKs from
        -- host_health_alerts so an alert's opening/resolving probe
        -- cannot belong to a different project than the alert itself.
        CONSTRAINT host_health_project_id_unique UNIQUE (project_id, id)
      );
    `);

    // Hot path: fetch the most recent probe per project to detect
    // transitions. The proc orders by (probed_at DESC, id DESC) so id is
    // the tiebreaker when multiple rows share a probed_at value (which
    // CAN happen because devloop_api has direct INSERT on this table).
    await queryRunner.query(`
      CREATE INDEX idx_host_health_project_probed
        ON public.host_health(project_id, probed_at DESC, id DESC);
    `);

    // ========================================================================
    // host_health_alerts — one row per alert episode
    // ========================================================================
    // Opened on transition into a non-'up' status (down or degraded),
    // resolved when status returns to 'up'. At most one open alert per
    // project is enforced by a partial unique index on the constant
    // expression TRUE WHERE resolved_at IS NULL. Acknowledged_* fields
    // are optional metadata for operator triage and are independent of
    // resolved_at: an alert can be acknowledged while still open, or
    // resolved without ever being acknowledged.
    await queryRunner.query(`
      CREATE TABLE public.host_health_alerts (
        id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id             uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
        opened_at              timestamptz NOT NULL DEFAULT now(),
        initial_status         public.health_status_enum NOT NULL,
        worst_status           public.health_status_enum NOT NULL,
        opening_probe_id       bigint NOT NULL,
        resolved_at            timestamptz NULL,
        resolving_probe_id     bigint NULL,
        acknowledged_at        timestamptz NULL,
        acknowledged_by        uuid NULL REFERENCES public.users(id) ON DELETE RESTRICT,
        acknowledgement_note   text NULL,
        -- Composite FKs force opening/resolving probe rows to belong to
        -- the same project as the alert, closing a cross-project data
        -- integrity gap that single-column FKs would leave open since
        -- devloop_api has direct INSERT on host_health_alerts.
        CONSTRAINT host_health_alerts_opening_probe_fk
          FOREIGN KEY (project_id, opening_probe_id)
          REFERENCES public.host_health(project_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT host_health_alerts_resolving_probe_fk
          FOREIGN KEY (project_id, resolving_probe_id)
          REFERENCES public.host_health(project_id, id)
          ON DELETE RESTRICT,
        CONSTRAINT host_health_alerts_initial_not_up CHECK (initial_status <> 'up'),
        CONSTRAINT host_health_alerts_worst_not_up CHECK (worst_status <> 'up'),
        CONSTRAINT host_health_alerts_resolved_consistency CHECK (
          (resolved_at IS NULL  AND resolving_probe_id IS NULL)
          OR
          (resolved_at IS NOT NULL AND resolving_probe_id IS NOT NULL)
        ),
        CONSTRAINT host_health_alerts_ack_consistency CHECK (
          (acknowledged_at IS NULL  AND acknowledged_by IS NULL)
          OR
          (acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL)
        ),
        -- An acknowledgement note can only exist on an acknowledged
        -- alert. Prevents writing a dangling note with no ack_at/ack_by
        -- via direct column-level UPDATE.
        CONSTRAINT host_health_alerts_note_requires_ack CHECK (
          acknowledgement_note IS NULL
          OR (acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL)
        )
      );
    `);

    // At most one open alert per project. The ON transition detection
    // in record_host_health_probe relies on this invariant.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_host_health_alerts_one_open_per_project
        ON public.host_health_alerts(project_id)
        WHERE resolved_at IS NULL;
    `);

    // FK support indexes for ON DELETE RESTRICT targets. The composite
    // FKs reference host_health(project_id, id) so the referring-side
    // index is (project_id, <probe_id>) — not a single-column index.
    await queryRunner.query(`
      CREATE INDEX idx_host_health_alerts_opening_probe
        ON public.host_health_alerts(project_id, opening_probe_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_host_health_alerts_resolving_probe
        ON public.host_health_alerts(project_id, resolving_probe_id)
        WHERE resolving_probe_id IS NOT NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX idx_host_health_alerts_acknowledged_by
        ON public.host_health_alerts(acknowledged_by)
        WHERE acknowledged_by IS NOT NULL;
    `);

    // ========================================================================
    // branch_protection_checks
    // ========================================================================
    // Compliance module writes a row on every check (project registration
    // and every 6h scheduler). Failure sets project status to 'paused' at
    // the application layer and emits compliance_check_failed.
    await queryRunner.query(`
      CREATE TABLE public.branch_protection_checks (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id        uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
        checked_at        timestamptz NOT NULL DEFAULT now(),
        is_protected      boolean NOT NULL,
        required_checks   text[] NOT NULL,
        allow_force_push  boolean NOT NULL,
        required_reviews  int NOT NULL,
        bypass_allowed    boolean NOT NULL,
        raw_response      jsonb NOT NULL,
        compliance_pass   boolean NOT NULL,
        failure_reason    text NULL,
        CONSTRAINT branch_protection_checks_required_reviews_nonneg CHECK (required_reviews >= 0),
        -- A failed compliance check must carry a reason; a passed one
        -- must not mislead operators with a dangling reason string.
        CONSTRAINT branch_protection_checks_failure_reason_consistency CHECK (
          (compliance_pass = true  AND failure_reason IS NULL)
          OR
          (compliance_pass = false AND failure_reason IS NOT NULL AND char_length(btrim(failure_reason)) > 0)
        )
      );
    `);

    // Hot path: most recent check per project. The §7.5 branch-protection
    // short-circuit reads (project_id, checked_at DESC) and accepts a
    // cached result < 5 minutes old.
    await queryRunner.query(`
      CREATE INDEX idx_branch_protection_checks_project_checked
        ON public.branch_protection_checks(project_id, checked_at DESC);
    `);

    // ========================================================================
    // record_host_health_probe — single entry point for health probes
    // ========================================================================
    // Inserts the probe row, detects transitions, opens/resolves alerts,
    // and emits the appropriate audit event. Returns the new probe id.
    //
    // Transition table:
    //   previous -> new    action
    //   (none)      up     insert probe, no alert, no audit
    //   (none)      down   insert probe, open alert, emit health_down
    //   (none)      degrad insert probe, open alert, emit health_degraded
    //   up          up     insert probe, no alert, no audit
    //   up          down   insert probe, open alert, emit health_down
    //   up          degrad insert probe, open alert, emit health_degraded
    //   down        down   insert probe, update worst_status if needed, no audit
    //   down        degrad insert probe, update worst_status if needed, no audit
    //   down        up     insert probe, resolve alert, emit health_up
    //   degrad      degrad insert probe, no audit
    //   degrad      down   insert probe, escalate worst_status, emit health_down
    //   degrad      up     insert probe, resolve alert, emit health_up
    //
    // The "escalate degraded → down" case is specifically audited because
    // it represents a worsening condition that may change on-call routing.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.record_host_health_probe(
        p_project_id    uuid,
        p_status        public.health_status_enum,
        p_probe_source  varchar(64),
        p_http_status   int DEFAULT NULL,
        p_latency_ms    int DEFAULT NULL,
        p_error_message text DEFAULT NULL
      ) RETURNS bigint
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_probe_id      bigint;
        v_prev_status   public.health_status_enum;
        v_open_alert_id uuid;
        v_open_worst    public.health_status_enum;
      BEGIN
        IF p_project_id IS NULL OR p_status IS NULL OR p_probe_source IS NULL THEN
          RAISE EXCEPTION 'record_host_health_probe: project_id, status, and probe_source are required';
        END IF;
        -- Match the table CHECK (char_length(btrim(...)) > 0) so the
        -- proc rejects whitespace-only probe_source with a clear error
        -- instead of relying on the CHECK constraint to bounce it.
        IF char_length(btrim(p_probe_source)) = 0 THEN
          RAISE EXCEPTION 'record_host_health_probe: probe_source must be non-empty';
        END IF;

        -- Serialize concurrent probes for the same project so transition
        -- detection and alert bookkeeping observe a consistent ordering.
        -- Without this, two near-simultaneous probes could both see the
        -- same "previous" row and both attempt to open an alert, tripping
        -- the partial unique index.
        PERFORM pg_advisory_xact_lock(
          hashtext('record_host_health_probe'),
          hashtext(p_project_id::text)
        );

        INSERT INTO public.host_health (
          project_id, status, probe_source, http_status, latency_ms, error_message
        ) VALUES (
          p_project_id, p_status, p_probe_source, p_http_status, p_latency_ms, p_error_message
        )
        RETURNING id INTO v_probe_id;

        -- Look up the most recent PRIOR probe for transition detection.
        -- ORDER BY (probed_at DESC, id DESC): probed_at is authoritative
        -- wall-clock ordering and id is the tiebreaker when two rows
        -- share the same probed_at value. We exclude the row we just
        -- inserted. devloop_api has direct INSERT on host_health so
        -- this ordering must not rely on insertion order alone.
        SELECT status INTO v_prev_status
          FROM public.host_health
         WHERE project_id = p_project_id
           AND id <> v_probe_id
         ORDER BY probed_at DESC, id DESC
         LIMIT 1;

        -- Look up any currently-open alert for this project.
        SELECT id, worst_status
          INTO v_open_alert_id, v_open_worst
          FROM public.host_health_alerts
         WHERE project_id = p_project_id
           AND resolved_at IS NULL
         FOR UPDATE;

        IF p_status = 'up' THEN
          IF v_open_alert_id IS NOT NULL THEN
            -- Resolve the open alert.
            UPDATE public.host_health_alerts
               SET resolved_at = now(),
                   resolving_probe_id = v_probe_id
             WHERE id = v_open_alert_id;

            PERFORM public.append_audit_event(
              p_project_id, NULL::uuid, NULL::uuid,
              'health_up'::public.audit_event_enum,
              'system'::public.actor_kind_enum,
              p_probe_source,
              jsonb_build_object(
                'alert_id', v_open_alert_id,
                'probe_id', v_probe_id
              ),
              NULL::varchar(32), NULL::varchar(32), NULL::varchar(64), NULL::varchar(32)
            );
          END IF;
          -- up → up and (none) → up: no audit, no alert action.
          RETURN v_probe_id;
        END IF;

        -- p_status is 'down' or 'degraded' from here on.
        IF v_open_alert_id IS NULL THEN
          -- No open alert. Open one iff the previous status was 'up' or
          -- the probe is the very first for this project. A safety
          -- invariant: if there is no open alert and the previous status
          -- was also not-'up', something is inconsistent — fall through
          -- to opening a new alert anyway so we do not silently drop a
          -- bad-state record.
          INSERT INTO public.host_health_alerts (
            project_id, initial_status, worst_status, opening_probe_id
          ) VALUES (
            p_project_id, p_status, p_status, v_probe_id
          )
          RETURNING id INTO v_open_alert_id;

          IF p_status = 'down' THEN
            PERFORM public.append_audit_event(
              p_project_id, NULL::uuid, NULL::uuid,
              'health_down'::public.audit_event_enum,
              'system'::public.actor_kind_enum,
              p_probe_source,
              jsonb_build_object(
                'alert_id', v_open_alert_id,
                'probe_id', v_probe_id,
                'prev_status', COALESCE(v_prev_status::text, 'none')
              ),
              NULL::varchar(32), NULL::varchar(32), NULL::varchar(64), NULL::varchar(32)
            );
          ELSE
            PERFORM public.append_audit_event(
              p_project_id, NULL::uuid, NULL::uuid,
              'health_degraded'::public.audit_event_enum,
              'system'::public.actor_kind_enum,
              p_probe_source,
              jsonb_build_object(
                'alert_id', v_open_alert_id,
                'probe_id', v_probe_id,
                'prev_status', COALESCE(v_prev_status::text, 'none')
              ),
              NULL::varchar(32), NULL::varchar(32), NULL::varchar(64), NULL::varchar(32)
            );
          END IF;
          RETURN v_probe_id;
        END IF;

        -- There is already an open alert. Possibly escalate worst_status
        -- and emit an audit event only on escalation degraded → down.
        IF p_status = 'down' AND v_open_worst = 'degraded' THEN
          UPDATE public.host_health_alerts
             SET worst_status = 'down'
           WHERE id = v_open_alert_id;
          PERFORM public.append_audit_event(
            p_project_id, NULL::uuid, NULL::uuid,
            'health_down'::public.audit_event_enum,
            'system'::public.actor_kind_enum,
            p_probe_source,
            jsonb_build_object(
              'alert_id', v_open_alert_id,
              'probe_id', v_probe_id,
              'escalation', 'degraded->down'
            ),
            NULL::varchar(32), NULL::varchar(32), NULL::varchar(64), NULL::varchar(32)
          );
        END IF;
        -- Other cases (down→down, down→degraded, degraded→degraded): no
        -- state change worth auditing; the history row itself is the record.
        RETURN v_probe_id;
      END;
      $fn$;
    `);

    // ========================================================================
    // acknowledge_host_health_alert
    // ========================================================================
    // Operator marks an open alert as acknowledged. Does not resolve it.
    // Returns true if an update occurred, false if the alert does not
    // exist or is already resolved (acknowledging a resolved alert is a
    // no-op rather than an error so the UI does not have to special-case
    // the "resolved while I was typing" race).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.acknowledge_host_health_alert(
        p_alert_id   uuid,
        p_user_id    uuid,
        p_note       text
      ) RETURNS boolean
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_project_id uuid;
        v_updated    integer;
      BEGIN
        IF p_alert_id IS NULL OR p_user_id IS NULL THEN
          RAISE EXCEPTION 'acknowledge_host_health_alert: alert_id and user_id are required';
        END IF;
        -- Normalize note: empty / whitespace-only becomes NULL so we
        -- never store a meaningless note, and the note_requires_ack
        -- CHECK is honored by construction.
        p_note := NULLIF(btrim(p_note), '');

        UPDATE public.host_health_alerts
           SET acknowledged_at      = now(),
               acknowledged_by      = p_user_id,
               acknowledgement_note = p_note
         WHERE id                   = p_alert_id
           AND resolved_at          IS NULL
           AND acknowledged_at      IS NULL
        RETURNING project_id INTO v_project_id;

        GET DIAGNOSTICS v_updated = ROW_COUNT;
        IF v_updated = 0 THEN RETURN false; END IF;

        PERFORM public.append_audit_event(
          v_project_id, NULL::uuid, NULL::uuid,
          'health_alert_sent'::public.audit_event_enum,
          'user'::public.actor_kind_enum,
          'operator-ack',
          jsonb_build_object(
            'alert_id', p_alert_id,
            'acknowledged_by', p_user_id
          ),
          NULL::varchar(32), NULL::varchar(32), NULL::varchar(64), NULL::varchar(32)
        );
        RETURN true;
      END;
      $fn$;
    `);

    // ========================================================================
    // record_branch_protection_check
    // ========================================================================
    // Compliance module inserts a row and this proc emits the correct
    // audit event. Failure_reason is required when compliance_pass=false
    // (enforced by CHECK).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.record_branch_protection_check(
        p_project_id        uuid,
        p_is_protected      boolean,
        p_required_checks   text[],
        p_allow_force_push  boolean,
        p_required_reviews  int,
        p_bypass_allowed    boolean,
        p_raw_response      jsonb,
        p_compliance_pass   boolean,
        p_failure_reason    text DEFAULT NULL
      ) RETURNS uuid
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_new_id uuid;
      BEGIN
        IF p_project_id IS NULL OR p_is_protected IS NULL
           OR p_required_checks IS NULL OR p_allow_force_push IS NULL
           OR p_required_reviews IS NULL OR p_bypass_allowed IS NULL
           OR p_raw_response IS NULL OR p_compliance_pass IS NULL THEN
          RAISE EXCEPTION 'record_branch_protection_check: all non-reason args must be non-null';
        END IF;
        -- Normalize whitespace-only reason to NULL before the gate.
        p_failure_reason := NULLIF(btrim(p_failure_reason), '');
        IF p_compliance_pass = false AND p_failure_reason IS NULL THEN
          RAISE EXCEPTION 'record_branch_protection_check: failure_reason required when compliance_pass=false';
        END IF;
        IF p_compliance_pass = true AND p_failure_reason IS NOT NULL THEN
          -- Normalize: passed checks do not carry a reason string.
          p_failure_reason := NULL;
        END IF;

        INSERT INTO public.branch_protection_checks (
          project_id, is_protected, required_checks, allow_force_push,
          required_reviews, bypass_allowed, raw_response, compliance_pass,
          failure_reason
        ) VALUES (
          p_project_id, p_is_protected, p_required_checks, p_allow_force_push,
          p_required_reviews, p_bypass_allowed, p_raw_response, p_compliance_pass,
          p_failure_reason
        )
        RETURNING id INTO v_new_id;

        PERFORM public.append_audit_event(
          p_project_id, NULL::uuid, NULL::uuid,
          CASE WHEN p_compliance_pass
               THEN 'compliance_check_passed'::public.audit_event_enum
               ELSE 'compliance_check_failed'::public.audit_event_enum
          END,
          'system'::public.actor_kind_enum,
          'compliance-monitor',
          jsonb_build_object(
            'check_id',         v_new_id,
            'is_protected',     p_is_protected,
            'required_reviews', p_required_reviews,
            'bypass_allowed',   p_bypass_allowed,
            'allow_force_push', p_allow_force_push,
            'failure_reason',   p_failure_reason
          ),
          NULL::varchar(32), NULL::varchar(32), NULL::varchar(64), NULL::varchar(32)
        );
        RETURN v_new_id;
      END;
      $fn$;
    `);

    // ========================================================================
    // Grants
    // ========================================================================
    // host_health: SELECT + INSERT granted directly (hot append path).
    // UPDATE/DELETE not granted — append-only.
    await queryRunner.query(`GRANT SELECT, INSERT ON public.host_health TO devloop_api;`);
    await queryRunner.query(`GRANT USAGE ON SEQUENCE public.host_health_id_seq TO devloop_api;`);

    // host_health_alerts: SELECT + INSERT + narrow UPDATE on ack columns.
    // Resolution happens via stored procedure only (never direct DML).
    await queryRunner.query(`GRANT SELECT, INSERT ON public.host_health_alerts TO devloop_api;`);
    await queryRunner.query(`
      GRANT UPDATE (acknowledged_at, acknowledged_by, acknowledgement_note)
        ON public.host_health_alerts TO devloop_api;
    `);

    // branch_protection_checks: SELECT + INSERT.
    await queryRunner.query(`GRANT SELECT, INSERT ON public.branch_protection_checks TO devloop_api;`);

    // Procedures.
    await queryRunner.query(`
      REVOKE ALL ON FUNCTION public.record_host_health_probe(uuid, public.health_status_enum, varchar, int, int, text) FROM PUBLIC;
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.record_host_health_probe(uuid, public.health_status_enum, varchar, int, int, text) TO devloop_api;
    `);
    await queryRunner.query(`
      REVOKE ALL ON FUNCTION public.acknowledge_host_health_alert(uuid, uuid, text) FROM PUBLIC;
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.acknowledge_host_health_alert(uuid, uuid, text) TO devloop_api;
    `);
    await queryRunner.query(`
      REVOKE ALL ON FUNCTION public.record_branch_protection_check(uuid, boolean, text[], boolean, int, boolean, jsonb, boolean, text) FROM PUBLIC;
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.record_branch_protection_check(uuid, boolean, text[], boolean, int, boolean, jsonb, boolean, text) TO devloop_api;
    `);

    // Defense-in-depth REVOKE ALL from PUBLIC on the new tables.
    await queryRunner.query(`REVOKE ALL ON public.host_health FROM PUBLIC;`);
    await queryRunner.query(`REVOKE ALL ON public.host_health_alerts FROM PUBLIC;`);
    await queryRunner.query(`REVOKE ALL ON public.branch_protection_checks FROM PUBLIC;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.record_branch_protection_check(uuid, boolean, text[], boolean, int, boolean, jsonb, boolean, text);
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.acknowledge_host_health_alert(uuid, uuid, text);
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.record_host_health_probe(uuid, public.health_status_enum, varchar, int, int, text);
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS public.branch_protection_checks;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.host_health_alerts;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.host_health;`);

    await queryRunner.query(`DROP TYPE IF EXISTS public.health_status_enum;`);
  }
}
