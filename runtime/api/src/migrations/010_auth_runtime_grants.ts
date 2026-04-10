import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 010 — runtime auth grants on public.users.
 *
 * Fas 0.9a's auth path needs to UPDATE a small set of columns on
 * public.users from the devloop_api role:
 *
 *   failed_login_count  — incremented on bad password, cleared on success
 *   locked_until        — set on lockout threshold, cleared on success
 *   last_login_at       — stamped on successful verify
 *   password_hash       — rewritten when needsRehash() reports the stored
 *                         hash uses weaker parameters than current policy
 *
 * Migration 002 only granted SELECT on public.users to devloop_api so the
 * login path would fail in production even though the smoke tests passed
 * under devloop_owner. This migration closes that gap with column-level
 * UPDATE grants — we intentionally do NOT grant blanket UPDATE to avoid
 * opening the role + email + 2fa fields to runtime rewrite.
 *
 * Reviewed in Fas 0.9a round 1 (gpt-5.4 medium) — critical issue was the
 * missing grants; this migration is the fix.
 */
export class AuthRuntimeGrants1712700000010 implements MigrationInterface {
  name = 'AuthRuntimeGrants1712700000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      GRANT UPDATE (
        failed_login_count,
        locked_until,
        last_login_at,
        password_hash
      ) ON public.users TO devloop_api;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      REVOKE UPDATE (
        failed_login_count,
        locked_until,
        last_login_at,
        password_hash
      ) ON public.users FROM devloop_api;
    `);
  }
}
