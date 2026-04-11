import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 012 — reports intake (Fas 1c).
 *
 * Scope:
 *   - public.reports: primary bug-report row per ARCHITECTURE.md §6.1.
 *     Created by a caller posting to POST /api/reports; holds the
 *     original user description plus a classifier-cleaned version
 *     (corrected_description) that the orchestrator produces later.
 *   - public.report_threads: ordered comment thread attached to a
 *     report. Authors are 'user', 'agent' (worker / reviewer output),
 *     or 'system' (state-change annotations from procedures).
 *   - public.report_artifacts: screenshots, recordings, logs linked
 *     to a report. Storage is by reference (storage_key); the blob
 *     backend is not built yet so the schema just records the key.
 *   - FK agent_tasks.report_id → reports(id) ON DELETE RESTRICT.
 *     Migration 004 declared report_id as NOT NULL uuid without an
 *     FK because the reports table did not exist yet.
 *   - orchestrate_task_for_report(p_report_id) SECURITY DEFINER
 *     procedure: transitions a report from 'new' to 'triaged' and
 *     creates a paired agent_tasks row in 'queued_for_lock'.
 *     For Fas 1c the module name and risk tier are defaulted to
 *     sensible stubs. The real classifier ships in a later phase.
 *
 * Grants:
 *   - devloop_api: SELECT + INSERT on reports; UPDATE on
 *     (status, corrected_description, triaged_at, resolved_at);
 *     SELECT + INSERT on report_threads; SELECT + INSERT on
 *     report_artifacts; EXECUTE on orchestrate_task_for_report.
 *   - devloop_api also gets INSERT on agent_tasks so the stub
 *     orchestrator can create task rows directly via the
 *     SECURITY DEFINER proc path. (The proc itself runs with
 *     owner privileges; this grant is for potential future
 *     non-proc orchestrator paths and is narrow.)
 */
export class Reports1712700000012 implements MigrationInterface {
  name = 'Reports1712700000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ========================================================================
    // reports
    // ========================================================================
    await queryRunner.query(`
      CREATE TABLE public.reports (
        id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id            uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
        title                 varchar(200) NOT NULL,
        description           text NOT NULL,
        corrected_description text NULL,
        status                public.report_status_enum NOT NULL DEFAULT 'new',
        risk_tier             public.risk_tier_enum NULL,
        reporter_user_id      uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
        reporter_external_id  varchar(256) NULL,
        created_at            timestamptz NOT NULL DEFAULT now(),
        triaged_at            timestamptz NULL,
        resolved_at           timestamptz NULL,
        CONSTRAINT reports_title_nonempty CHECK (char_length(btrim(title)) > 0),
        CONSTRAINT reports_description_nonempty CHECK (char_length(btrim(description)) > 0),
        CONSTRAINT reports_triaged_after_created CHECK (
          triaged_at IS NULL OR triaged_at >= created_at
        ),
        CONSTRAINT reports_resolved_after_triaged CHECK (
          resolved_at IS NULL OR triaged_at IS NULL OR resolved_at >= triaged_at
        ),
        -- terminal statuses must have resolved_at
        CONSTRAINT reports_terminal_requires_resolved CHECK (
          status NOT IN ('fix_deployed', 'verified', 'wont_fix', 'cancelled')
          OR resolved_at IS NOT NULL
        )
      );
    `);

    // Hot path: list reports per project newest-first.
    await queryRunner.query(`
      CREATE INDEX idx_reports_project_created
        ON public.reports(project_id, created_at DESC);
    `);

    // Orchestrator pickup index: reports with status='new' by oldest first.
    await queryRunner.query(`
      CREATE INDEX idx_reports_new_pickup
        ON public.reports(created_at)
        WHERE status = 'new';
    `);

    // FK support index for ON DELETE SET NULL from users.
    await queryRunner.query(`
      CREATE INDEX idx_reports_reporter_user_id
        ON public.reports(reporter_user_id)
        WHERE reporter_user_id IS NOT NULL;
    `);

    // ========================================================================
    // report_threads
    // ========================================================================
    await queryRunner.query(`
      CREATE TABLE public.report_threads (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        report_id     uuid NOT NULL REFERENCES public.reports(id) ON DELETE CASCADE,
        author_kind   public.thread_author_enum NOT NULL,
        author_name   varchar(128) NOT NULL,
        body          text NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT report_threads_author_name_nonempty CHECK (char_length(btrim(author_name)) > 0),
        CONSTRAINT report_threads_body_nonempty CHECK (char_length(btrim(body)) > 0)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_report_threads_report_created
        ON public.report_threads(report_id, created_at ASC);
    `);

    // ========================================================================
    // report_artifacts
    // ========================================================================
    // Storage-by-reference: the blob backend is not built yet; this
    // table just records metadata + a storage_key that a future
    // artifact service will resolve. Fas 1c does not implement upload.
    await queryRunner.query(`
      CREATE TABLE public.report_artifacts (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        report_id   uuid NOT NULL REFERENCES public.reports(id) ON DELETE CASCADE,
        kind        public.artifact_kind_enum NOT NULL,
        filename    varchar(255) NULL,
        mime_type   varchar(128) NULL,
        size_bytes  bigint NULL,
        storage_key varchar(512) NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT report_artifacts_storage_key_nonempty CHECK (char_length(btrim(storage_key)) > 0),
        CONSTRAINT report_artifacts_size_bytes_positive CHECK (
          size_bytes IS NULL OR size_bytes > 0
        )
      );
    `);

    await queryRunner.query(`
      CREATE INDEX idx_report_artifacts_report
        ON public.report_artifacts(report_id);
    `);

    // ========================================================================
    // Close the agent_tasks.report_id FK loop
    // ========================================================================
    // Migration 004 declared report_id NOT NULL uuid without an FK
    // because reports did not exist yet. Add the FK now.
    await queryRunner.query(`
      ALTER TABLE public.agent_tasks
        ADD CONSTRAINT agent_tasks_report_id_fkey
        FOREIGN KEY (report_id) REFERENCES public.reports(id) ON DELETE RESTRICT;
    `);

    // ========================================================================
    // orchestrate_task_for_report (Fas 1c stub)
    // ========================================================================
    // Takes a report id, marks the report 'triaged', and creates a
    // paired agent_tasks row in 'queued_for_lock'. Real classification
    // (module selection, risk tier scoring, agent routing) is stubbed —
    // module defaults to 'unknown', risk_tier to 'standard', agent_name
    // to 'claude'. Later phases replace this body with real logic but
    // the contract (one report → one task, transition to triaged) is
    // stable.
    //
    // Returns the new agent_tasks.id, or NULL if the report was not
    // in 'new' status.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.orchestrate_task_for_report(
        p_report_id uuid
      ) RETURNS uuid
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      DECLARE
        v_project_id uuid;
        v_title      varchar(200);
        v_new_task   uuid;
        v_display_id varchar(64);
        v_seq        bigint;
      BEGIN
        IF p_report_id IS NULL THEN
          RAISE EXCEPTION 'orchestrate_task_for_report: report_id required';
        END IF;

        -- Lock the report row for the duration of the transaction so a
        -- concurrent orchestrator call cannot double-create a task.
        SELECT project_id, title
          INTO v_project_id, v_title
          FROM public.reports
         WHERE id = p_report_id
           AND status = 'new'
         FOR UPDATE;

        IF NOT FOUND THEN
          RETURN NULL;
        END IF;

        -- Build a per-project monotonic display_id. Scoped per
        -- project so operators see T-1, T-2, ... per project. The
        -- max+1 pattern is safe under the row lock above because we
        -- hold a SHARE lock on the project row's subtree via the FK.
        -- A race across DIFFERENT reports in the same project is
        -- still possible; the partial unique index on display_id
        -- (per project) is the hard backstop.
        SELECT COALESCE(
          MAX(NULLIF(regexp_replace(display_id, '^T-', ''), '')::bigint),
          0
        ) + 1
          INTO v_seq
          FROM public.agent_tasks
         WHERE project_id = v_project_id
           AND display_id ~ '^T-[0-9]+$';
        v_display_id := 'T-' || v_seq::text;

        INSERT INTO public.agent_tasks (
          project_id, report_id, display_id, agent_name, module,
          risk_tier, status
        ) VALUES (
          v_project_id, p_report_id, v_display_id, 'claude', 'unknown',
          'standard'::public.risk_tier_enum,
          'queued_for_lock'::public.task_status_enum
        )
        RETURNING id INTO v_new_task;

        -- Promote the report to 'triaged'.
        UPDATE public.reports
           SET status = 'triaged',
               triaged_at = now()
         WHERE id = p_report_id;

        PERFORM public.append_audit_event(
          v_project_id, v_new_task, p_report_id,
          'task_created'::public.audit_event_enum,
          'system'::public.actor_kind_enum,
          'orchestrator-stub',
          jsonb_build_object(
            'report_id',  p_report_id,
            'display_id', v_display_id,
            'title',      v_title,
            'module',     'unknown',
            'risk_tier',  'standard'
          ),
          NULL::varchar(32), 'queued_for_lock'::varchar(32),
          NULL::varchar(64), NULL::varchar(32)
        );
        PERFORM public.append_audit_event(
          v_project_id, NULL::uuid, p_report_id,
          'report_triaged'::public.audit_event_enum,
          'system'::public.actor_kind_enum,
          'orchestrator-stub',
          jsonb_build_object(
            'report_id',   p_report_id,
            'new_task_id', v_new_task
          ),
          'new'::varchar(32), 'triaged'::varchar(32),
          NULL::varchar(64), NULL::varchar(32)
        );

        RETURN v_new_task;
      END;
      $fn$;
    `);

    // ========================================================================
    // Grants
    // ========================================================================
    // Column-level UPDATE on reports (no blanket UPDATE — blocks a
    // runtime bug from rewriting description or switching project_id).
    await queryRunner.query(`GRANT SELECT, INSERT ON public.reports TO devloop_api;`);
    await queryRunner.query(`
      GRANT UPDATE (status, corrected_description, triaged_at, resolved_at)
        ON public.reports TO devloop_api;
    `);

    // report_threads: append-only from runtime.
    await queryRunner.query(`GRANT SELECT, INSERT ON public.report_threads TO devloop_api;`);

    // report_artifacts: append-only, with a narrow UPDATE on size_bytes
    // + mime_type so an upload finalization step can stamp them once
    // the blob reaches storage.
    await queryRunner.query(`GRANT SELECT, INSERT ON public.report_artifacts TO devloop_api;`);
    await queryRunner.query(`
      GRANT UPDATE (size_bytes, mime_type)
        ON public.report_artifacts TO devloop_api;
    `);

    // Defense-in-depth REVOKE from PUBLIC.
    await queryRunner.query(`REVOKE ALL ON public.reports FROM PUBLIC;`);
    await queryRunner.query(`REVOKE ALL ON public.report_threads FROM PUBLIC;`);
    await queryRunner.query(`REVOKE ALL ON public.report_artifacts FROM PUBLIC;`);

    // Procedure grants.
    await queryRunner.query(`
      REVOKE ALL ON FUNCTION public.orchestrate_task_for_report(uuid) FROM PUBLIC;
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION public.orchestrate_task_for_report(uuid) TO devloop_api;
    `);

    // INSERT on agent_tasks narrow column list so the stub
    // orchestrator path (and future direct-INSERT admin tooling)
    // works. The SECURITY DEFINER proc runs as devloop_owner so it
    // does not strictly need this, but a runtime bug that tries
    // INSERT outside the proc will surface as a clear permission
    // error rather than a misleading FK error.
    await queryRunner.query(`
      GRANT INSERT (
        project_id, report_id, display_id, agent_name, module,
        risk_tier, status
      ) ON public.agent_tasks TO devloop_api;
    `);
    await queryRunner.query(`GRANT SELECT ON public.agent_tasks TO devloop_api;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS public.orchestrate_task_for_report(uuid);
    `);
    await queryRunner.query(`
      ALTER TABLE public.agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_report_id_fkey;
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS public.report_artifacts;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.report_threads;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.reports;`);
  }
}
