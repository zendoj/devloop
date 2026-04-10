import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 001 — initialize Postgres extensions and all enum types.
 *
 * Scope (Fas 0.2):
 *   - Enable required extensions: pgcrypto (for gen_random_uuid, digest)
 *   - Create all enum types used across the schema per ARCHITECTURE.md §6
 *
 * This migration creates NO tables. Table creation is deferred to migration 002+
 * so that enum and extension concerns are cleanly separated from structural
 * schema concerns. A future ALTER TYPE ... ADD VALUE would not need a table
 * restructure, and vice versa.
 *
 * Reversibility: `down()` drops all enums in reverse order. `pgcrypto` is
 * intentionally NOT disabled on rollback — it may be in use by other schemas
 * or databases on the same PG cluster, and enabling it is idempotent, so
 * leaving it installed is the safe choice.
 * Tested manually: up → verify 15 enums → down → verify 0 enums → up again.
 */
export class InitEnumsAndExtensions1712700000001 implements MigrationInterface {
  name = 'InitEnumsAndExtensions1712700000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- Extensions ---
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

    // --- User and session enums (§4.2 users, sessions) ---
    await queryRunner.query(`
      CREATE TYPE user_role_enum AS ENUM (
        'super_admin',
        'admin',
        'viewer'
      );
    `);

    // --- Project enums (§4.2 projects) ---
    await queryRunner.query(`
      CREATE TYPE project_status_enum AS ENUM (
        'active',
        'paused',
        'archived'
      );
    `);

    // --- Report lifecycle (§6.1) ---
    await queryRunner.query(`
      CREATE TYPE report_status_enum AS ENUM (
        'new',
        'triaged',
        'in_progress',
        'needs_info',
        'fix_deployed',
        'verified',
        'wont_fix',
        'cancelled'
      );
    `);

    await queryRunner.query(`
      CREATE TYPE thread_author_enum AS ENUM (
        'user',
        'agent',
        'system'
      );
    `);

    await queryRunner.query(`
      CREATE TYPE artifact_kind_enum AS ENUM (
        'screenshot',
        'recording_frame',
        'attachment',
        'recording_log'
      );
    `);

    // --- Task lifecycle (§6.2) ---
    await queryRunner.query(`
      CREATE TYPE task_status_enum AS ENUM (
        'queued_for_lock',
        'assigned',
        'in_progress',
        'review',
        'changes_requested',
        'approved',
        'deploying',
        'merged',
        'verifying',
        'verified',
        'rolling_back',
        'rolled_back',
        'rollback_failed',
        'blocked',
        'cancelled',
        'failed'
      );
    `);

    await queryRunner.query(`
      CREATE TYPE risk_tier_enum AS ENUM (
        'low',
        'standard',
        'high',
        'critical'
      );
    `);

    await queryRunner.query(`
      CREATE TYPE review_decision_enum AS ENUM (
        'approved',
        'changes_requested',
        'rejected'
      );
    `);

    // --- Desired state / deploy enums (§4.2 desired_state_history) ---
    await queryRunner.query(`
      CREATE TYPE desired_action_enum AS ENUM (
        'deploy',
        'rollback',
        'baseline'
      );
    `);

    await queryRunner.query(`
      CREATE TYPE apply_status_enum AS ENUM (
        'success',
        'failed',
        'timed_out'
      );
    `);

    // --- Signing key enums (§4.2 signing_keys) ---
    await queryRunner.query(`
      CREATE TYPE signing_algorithm_enum AS ENUM (
        'ed25519'
      );
    `);

    await queryRunner.query(`
      CREATE TYPE signing_key_status_enum AS ENUM (
        'active',
        'retired',
        'revoked'
      );
    `);

    // --- Job queue enum (§4.2 jobs) ---
    await queryRunner.query(`
      CREATE TYPE job_status_enum AS ENUM (
        'pending',
        'claimed',
        'done',
        'failed'
      );
    `);

    // --- Audit enums (§4.2 audit_events, §6.4) ---
    await queryRunner.query(`
      CREATE TYPE actor_kind_enum AS ENUM (
        'user',
        'agent',
        'system'
      );
    `);

    // audit_event_enum is the exhaustive vocabulary from ARCHITECTURE.md §4.2.
    // Adding a new event type requires a new migration with ALTER TYPE ... ADD VALUE.
    await queryRunner.query(`
      CREATE TYPE audit_event_enum AS ENUM (
        'report_received',
        'report_triaged',
        'report_status_changed',
        'report_thread_added',
        'task_created',
        'task_status_changed',
        'task_blocked',
        'task_unblocked',
        'lock_acquired',
        'lock_renewed',
        'lock_released',
        'lock_fenced',
        'worker_spawned',
        'worker_heartbeat',
        'worker_exited',
        'worker_killed_timeout',
        'review_started',
        'review_completed',
        'review_approved',
        'review_changes_requested',
        'review_api_failure',
        'review_stale_sha',
        'review_quota_exceeded',
        'deploy_mutex_acquired',
        'deploy_mutex_renewed',
        'deploy_mutex_released',
        'deploy_started',
        'deploy_pr_created',
        'deploy_merge_blocked',
        'deploy_ci_waiting',
        'deploy_ci_passed',
        'deploy_ci_failed',
        'deploy_merged',
        'deploy_desired_state_written',
        'deploy_host_apply_started',
        'deploy_host_apply_heartbeat',
        'deploy_host_applied',
        'deploy_host_apply_failed',
        'deploy_host_apply_duplicate_or_missing',
        'deploy_host_apply_late_after_timeout',
        'deploy_verified',
        'host_apply_timeout',
        'host_heartbeat_timeout',
        'deploy_rollback_started',
        'deploy_rolled_back',
        'deploy_rollback_failed',
        'health_up',
        'health_down',
        'health_degraded',
        'health_alert_sent',
        'user_login',
        'user_login_failed',
        'user_logout',
        'user_2fa_enabled',
        'user_2fa_failed',
        'project_registered',
        'project_paused',
        'project_archived',
        'project_config_activated',
        'compliance_check_passed',
        'compliance_check_failed',
        'host_token_rotated',
        'deploy_token_rotated',
        'signing_key_rotated',
        'audit_chain_verified',
        'audit_chain_mismatch'
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse order of creation.
    await queryRunner.query(`DROP TYPE IF EXISTS audit_event_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS actor_kind_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS job_status_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS signing_key_status_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS signing_algorithm_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS apply_status_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS desired_action_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS review_decision_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS risk_tier_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS task_status_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS artifact_kind_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS thread_author_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS report_status_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS project_status_enum;`);
    await queryRunner.query(`DROP TYPE IF EXISTS user_role_enum;`);
    // Do NOT drop the pgcrypto extension on down(). It may be in use by other
    // schemas/databases on the same PG cluster. Extensions are idempotent and
    // safe to leave enabled.
  }
}
