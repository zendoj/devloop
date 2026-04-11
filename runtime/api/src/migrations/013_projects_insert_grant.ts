import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 013 — INSERT grant on public.projects for devloop_api.
 *
 * Fas 1d adds a project-registration endpoint. The runtime role
 * needs INSERT to actually create rows. Migration 002 granted
 * SELECT only + column-level UPDATE on a small allowlist; INSERT
 * was deferred until there was a real need for it.
 */
export class ProjectsInsertGrant1712700000013 implements MigrationInterface {
  name = 'ProjectsInsertGrant1712700000013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      GRANT INSERT ON public.projects TO devloop_api;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      REVOKE INSERT ON public.projects FROM devloop_api;
    `);
  }
}
