import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 003 — audit infrastructure.
 *
 * Scope (Fas 0.3b):
 *   - audit_chain_head table (single-row, holds last hash for chain extension)
 *   - audit_events table (append-only, hash-chained, per ARCHITECTURE.md §4.2)
 *   - BEFORE UPDATE/DELETE/TRUNCATE triggers that raise exceptions
 *   - append_audit_event() SECURITY DEFINER stored procedure with pg_advisory_xact_lock
 *   - Genesis row seeded into audit_chain_head (id=1, last_event_id=0, last_hash=32 zero bytes)
 *   - Grants per §19 D26: devloop_api has SELECT on audit_events + EXECUTE on append_audit_event
 *     (NO direct INSERT/UPDATE/DELETE/TRUNCATE)
 *
 * Deferred to later phases:
 *   - FK constraints on audit_events.task_id (→ agent_tasks), .report_id (→ reports)
 *     — those tables don't exist yet
 *   - Grants to devloop_orch, devloop_rev, devloop_dep, devloop_wm (roles not created yet)
 *
 * Canonical payload format for chain hashing:
 *   The payload is a JSONB object with keys serialized via PostgreSQL's
 *   native jsonb_build_object() then ::text cast. This is NOT RFC 8785 JCS —
 *   it's a PostgreSQL-internal canonicalization. The chain hash is used only
 *   for tamper detection inside the central DB, not for signature verification
 *   across systems (see §19 D8 for the deploy-path signing which IS JCS).
 */
export class AuditInfrastructure1712700000003 implements MigrationInterface {
  name = 'AuditInfrastructure1712700000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- audit_chain_head ---
    // Single-row table, enforced via PK CHECK. Holds the "current tip" of the
    // audit hash chain. append_audit_event() locks this row FOR UPDATE inside
    // a transaction while also holding an advisory lock, to serialize chain
    // extension across concurrent callers.
    await queryRunner.query(`
      CREATE TABLE audit_chain_head (
        id            smallint PRIMARY KEY CHECK (id = 1),
        last_event_id bigint NOT NULL,
        last_hash     bytea NOT NULL CHECK (octet_length(last_hash) = 32),
        updated_at    timestamptz NOT NULL DEFAULT now()
      );
    `);

    // --- audit_events ---
    // Append-only. Each row is a link in a SHA-256 hash chain back to genesis.
    // FKs to projects only — task_id and report_id are nullable without FKs
    // and will get FK constraints added in Fas 0.4 / Fas 1.x.
    await queryRunner.query(`
      CREATE TABLE audit_events (
        id              bigserial PRIMARY KEY,
        project_id      uuid NULL REFERENCES projects(id) ON DELETE RESTRICT,
        task_id         uuid NULL,
        report_id       uuid NULL,
        event_type      audit_event_enum NOT NULL,
        actor_kind      actor_kind_enum NOT NULL,
        actor_name      varchar(128) NOT NULL,
        from_status     varchar(32) NULL,
        to_status       varchar(32) NULL,
        commit_sha      varchar(64) NULL,
        review_decision varchar(32) NULL,
        details         jsonb NOT NULL DEFAULT '{}'::jsonb,
        chain_prev_id   bigint NOT NULL CHECK (chain_prev_id >= 0),
        chain_hash      bytea NOT NULL CHECK (octet_length(chain_hash) = 32),
        created_at      timestamptz NOT NULL DEFAULT now()
      );
    `);
    // chain_prev_id invariant:
    //   = 0           for the first event after genesis (points at sentinel)
    //   = <id of N-1> for every subsequent event
    // Never NULL. append_audit_event() populates this from audit_chain_head.last_event_id.

    await queryRunner.query(`
      CREATE INDEX idx_audit_events_project_created
        ON audit_events(project_id, created_at);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_audit_events_task_created
        ON audit_events(task_id, created_at) WHERE task_id IS NOT NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX idx_audit_events_type_created
        ON audit_events(event_type, created_at);
    `);

    // --- Immutability enforcement: BEFORE UPDATE/DELETE/TRUNCATE triggers ---
    // Defense-in-depth: even though devloop_api has no direct write grants
    // (only EXECUTE on append_audit_event), a trigger provides a second barrier.
    // A compromised or buggy component attempting direct UPDATE/DELETE/TRUNCATE
    // hits a hard RAISE EXCEPTION before any row is modified.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION audit_events_no_mutate()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $fn$
      BEGIN
        RAISE EXCEPTION 'audit_events is append-only; use append_audit_event() to insert. Direct UPDATE/DELETE/TRUNCATE is forbidden.';
      END;
      $fn$;
    `);

    await queryRunner.query(`
      CREATE TRIGGER audit_events_immutable_update
        BEFORE UPDATE ON audit_events
        FOR EACH STATEMENT
        EXECUTE FUNCTION audit_events_no_mutate();
    `);
    await queryRunner.query(`
      CREATE TRIGGER audit_events_immutable_delete
        BEFORE DELETE ON audit_events
        FOR EACH STATEMENT
        EXECUTE FUNCTION audit_events_no_mutate();
    `);
    await queryRunner.query(`
      CREATE TRIGGER audit_events_immutable_truncate
        BEFORE TRUNCATE ON audit_events
        FOR EACH STATEMENT
        EXECUTE FUNCTION audit_events_no_mutate();
    `);

    // --- append_audit_event() SECURITY DEFINER procedure ---
    // This is the ONLY supported path to insert into audit_events. Runtime
    // roles have no direct INSERT grant; they must call this function.
    //
    // Parameters include the four first-class audit columns (from_status,
    // to_status, commit_sha, review_decision) so they can be populated by
    // state-machine transitions, review outcomes, and deploy flows. All four
    // are nullable and default to NULL for events that don't need them.
    // Every parameter participates in the hash chain payload for tamper
    // detection integrity.
    //
    // The function:
    //   1. Takes pg_advisory_xact_lock(7331) to serialize chain extension
    //   2. Reads audit_chain_head with FOR UPDATE
    //   3. Captures a single v_now timestamp used in BOTH the hash payload
    //      AND the INSERT's created_at (prevents any drift)
    //   4. Computes sha256(last_hash || canonical_payload)
    //   5. Inserts the new event with chain_prev_id and chain_hash
    //   6. Updates audit_chain_head to point at the new tip
    //   7. Returns the new event id
    //
    // SECURITY DEFINER runs as the function owner (devloop_owner), which has
    // all privileges on audit_events and audit_chain_head. This bypasses the
    // runtime role's lack of direct write grants.
    //
    // SEARCH PATH HARDENING:
    //   SET search_path = pg_catalog, pg_temp   (public is NOT in the path)
    // Combined with FULL SCHEMA QUALIFICATION of every non-catalog object
    // (public.audit_chain_head, public.audit_events, public.digest), this
    // prevents a pg_temp shadowing attack where a caller creates a temp
    // table named audit_events and causes the function to write to it
    // instead of the real table. Postgres always searches pg_temp first
    // for unqualified names, but explicit qualification bypasses the
    // search path entirely.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.append_audit_event(
        p_project_id       uuid,
        p_task_id          uuid,
        p_report_id        uuid,
        p_event_type       audit_event_enum,
        p_actor_kind       actor_kind_enum,
        p_actor_name       varchar(128),
        p_details          jsonb,
        p_from_status      varchar(32) DEFAULT NULL,
        p_to_status        varchar(32) DEFAULT NULL,
        p_commit_sha       varchar(64) DEFAULT NULL,
        p_review_decision  varchar(32) DEFAULT NULL
      ) RETURNS bigint
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_prev_id   bigint;
        v_prev_hash bytea;
        v_new_hash  bytea;
        v_new_id    bigint;
        v_payload   bytea;
        v_now       timestamptz;
      BEGIN
        IF p_actor_name IS NULL OR char_length(p_actor_name) = 0 THEN
          RAISE EXCEPTION 'append_audit_event: actor_name must be non-empty';
        END IF;

        -- Capture a single timestamp and reuse it in the hashed payload AND
        -- the INSERT so the hash input matches the stored created_at exactly.
        v_now := now();

        -- Serialize chain extension with a constant advisory lock key.
        -- This is transaction-scoped: released automatically on COMMIT/ROLLBACK.
        PERFORM pg_advisory_xact_lock(7331);

        SELECT last_event_id, last_hash INTO v_prev_id, v_prev_hash
          FROM public.audit_chain_head WHERE id = 1 FOR UPDATE;

        IF v_prev_hash IS NULL THEN
          RAISE EXCEPTION 'append_audit_event: audit_chain_head is empty; genesis row missing';
        END IF;

        -- Canonicalize the payload: a fixed-key JSONB object cast to text,
        -- then encoded as UTF-8 bytes. Note this is PG-internal canonicalization,
        -- NOT RFC 8785 JCS. For cross-system signing use the deploy-path per D8.
        -- All first-class columns are included so they cannot be tampered with
        -- without invalidating the chain hash.
        --
        -- Timestamp hashing: we use epoch microseconds as a bigint, not the
        -- raw timestamptz text rendering. Reason: jsonb serialization of
        -- timestamptz depends on the session's TimeZone GUC, which would make
        -- the chain hash caller-environment-dependent and prevent later
        -- verification from a different client. Epoch microseconds is a
        -- bigint with no timezone formatting, fully GUC-independent.
        v_payload := convert_to(
          jsonb_build_object(
            'project_id',           p_project_id,
            'task_id',              p_task_id,
            'report_id',            p_report_id,
            'event_type',           p_event_type::text,
            'actor_kind',           p_actor_kind::text,
            'actor_name',           p_actor_name,
            'from_status',          p_from_status,
            'to_status',            p_to_status,
            'commit_sha',           p_commit_sha,
            'review_decision',      p_review_decision,
            'details',              COALESCE(p_details, '{}'::jsonb),
            'created_at_epoch_us',  ((extract(epoch from v_now) * 1000000)::bigint)
          )::text,
          'UTF8'
        );

        -- public.digest() is from pgcrypto installed in the public schema
        -- (see migration 001). Explicit qualification avoids any pg_temp
        -- shadowing of a function named "digest".
        v_new_hash := public.digest(v_prev_hash || v_payload, 'sha256');

        INSERT INTO public.audit_events (
          project_id, task_id, report_id,
          event_type, actor_kind, actor_name,
          from_status, to_status, commit_sha, review_decision,
          details,
          chain_prev_id, chain_hash, created_at
        ) VALUES (
          p_project_id, p_task_id, p_report_id,
          p_event_type, p_actor_kind, p_actor_name,
          p_from_status, p_to_status, p_commit_sha, p_review_decision,
          COALESCE(p_details, '{}'::jsonb),
          v_prev_id, v_new_hash, v_now
        ) RETURNING id INTO v_new_id;

        UPDATE public.audit_chain_head
           SET last_event_id = v_new_id,
               last_hash     = v_new_hash,
               updated_at    = v_now
         WHERE id = 1;

        RETURN v_new_id;
      END;
      $fn$;
    `);

    // --- Grants ---
    // devloop_api: SELECT on audit_events (for dashboard search), EXECUTE on append_audit_event
    // All function references are schema-qualified as public.append_audit_event
    // to match the hardening inside the function body and remain correct under
    // non-default search_paths.
    await queryRunner.query(`GRANT SELECT ON public.audit_events TO devloop_api;`);
    await queryRunner.query(`
      REVOKE ALL ON FUNCTION public.append_audit_event(uuid, uuid, uuid, audit_event_enum, actor_kind_enum, varchar, jsonb, varchar, varchar, varchar, varchar) FROM PUBLIC;
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.append_audit_event(uuid, uuid, uuid, audit_event_enum, actor_kind_enum, varchar, jsonb, varchar, varchar, varchar, varchar) TO devloop_api;
    `);
    // Defense-in-depth: explicitly revoke all on audit_chain_head from PUBLIC
    // even though default privileges already exclude devloop_api.
    await queryRunner.query(`REVOKE ALL ON public.audit_chain_head FROM PUBLIC;`);
    // Note: audit_chain_head is NOT granted to any runtime role directly.
    // Only the SECURITY DEFINER function touches it (as devloop_owner).

    // --- Genesis row ---
    // last_event_id = 0 (sentinel — no events yet)
    // last_hash = 32 zero bytes (genesis hash, acts as the IV for the chain)
    // Any subsequent append computes sha256(zero_bytes || payload) as the
    // first real chain_hash, and the first event's chain_prev_id = 0.
    //
    // ON CONFLICT DO NOTHING makes this rerun-safe: if the row already exists
    // (partial migration re-run, or manual seed before migration), we don't
    // overwrite live chain state.
    await queryRunner.query(`
      INSERT INTO public.audit_chain_head (id, last_event_id, last_hash)
      VALUES (
        1,
        0,
        decode('0000000000000000000000000000000000000000000000000000000000000000', 'hex')
      )
      ON CONFLICT (id) DO NOTHING;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revoke grants (schema-qualified to match up())
    await queryRunner.query(`
      REVOKE EXECUTE ON FUNCTION public.append_audit_event(uuid, uuid, uuid, audit_event_enum, actor_kind_enum, varchar, jsonb, varchar, varchar, varchar, varchar) FROM devloop_api;
    `);
    await queryRunner.query(`REVOKE SELECT ON public.audit_events FROM devloop_api;`);

    // Drop the function (schema-qualified)
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.append_audit_event(uuid, uuid, uuid, audit_event_enum, actor_kind_enum, varchar, jsonb, varchar, varchar, varchar, varchar);
    `);

    // Drop triggers (must drop before the table, though DROP TABLE would do
    // it too — being explicit makes down() easier to audit)
    await queryRunner.query(`DROP TRIGGER IF EXISTS audit_events_immutable_truncate ON audit_events;`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS audit_events_immutable_delete ON audit_events;`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS audit_events_immutable_update ON audit_events;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS audit_events_no_mutate();`);

    // DROP TABLE is a DDL operation; BEFORE DELETE/TRUNCATE triggers do not
    // fire on DDL. The table drops cleanly.
    await queryRunner.query(`DROP TABLE IF EXISTS audit_events;`);
    await queryRunner.query(`DROP TABLE IF EXISTS audit_chain_head;`);
  }
}
