import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 011 — 2FA runtime grants on public.users.
 *
 * Fas 0.9b needs to UPDATE two_factor_secret (encrypted blob) and
 * two_factor_enrolled (flag) on public.users from the devloop_api
 * role. Migration 010 granted the login-path column UPDATEs; this
 * one extends the list specifically for the 2FA enrollment /
 * confirmation flows.
 *
 * Column-level grants keep the runtime role narrow: devloop_api
 * still cannot touch role, email, or two_factor_required.
 */
export class TwoFactorGrants1712700000011 implements MigrationInterface {
  name = 'TwoFactorGrants1712700000011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      GRANT UPDATE (
        two_factor_secret,
        two_factor_enrolled
      ) ON public.users TO devloop_api;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      REVOKE UPDATE (
        two_factor_secret,
        two_factor_enrolled
      ) ON public.users FROM devloop_api;
    `);
  }
}
