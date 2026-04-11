import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 024 — report_attachments for the rich bug-report
 * widget (screenshot, console log, network log, state dump,
 * element selector).
 *
 * One row per attached artifact. Content is stored as base64 in
 * a TEXT column (same pattern as task_feedback.files jsonb). Size
 * is capped at the API layer (host-reports controller) — there's
 * no hard DB constraint beyond toast size so large screenshots
 * don't bounce on insertion.
 *
 * devloop_api gets INSERT/SELECT so the host-reports endpoint
 * can write on intake and /tasks/:id can read on render.
 */
export class ReportAttachments1712700000024 implements MigrationInterface {
  name = 'ReportAttachments1712700000024';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.report_attachments (
        id              bigserial PRIMARY KEY,
        report_id       uuid NOT NULL REFERENCES public.reports(id) ON DELETE CASCADE,
        name            varchar(255) NOT NULL,
        mime_type       varchar(128) NOT NULL DEFAULT 'application/octet-stream',
        size_bytes      integer NOT NULL,
        content_base64  text NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT report_attachments_name_nonempty CHECK (char_length(btrim(name)) > 0),
        CONSTRAINT report_attachments_size_nonneg CHECK (size_bytes >= 0)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_report_attachments_report
        ON public.report_attachments (report_id, created_at)
    `);
    await queryRunner.query(`
      GRANT SELECT, INSERT ON public.report_attachments TO devloop_api
    `);
    await queryRunner.query(`
      GRANT USAGE, SELECT ON SEQUENCE public.report_attachments_id_seq TO devloop_api
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.report_attachments`);
  }
}
