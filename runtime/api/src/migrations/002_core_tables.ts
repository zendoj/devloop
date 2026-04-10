import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 002 — core tables: users, sessions, projects.
 *
 * Scope (Fas 0.3a):
 *   - Enable citext extension (case-insensitive email)
 *   - Create `users` table with Argon2id password_hash, 2FA fields
 *   - Create `sessions` table with FK to users (ON DELETE CASCADE)
 *   - Create `projects` table with all registration fields per
 *     ARCHITECTURE.md §4.2 (MVP scope — some columns added in later
 *     phases when needed by specific features)
 *   - Grants to devloop_api per §19 D26 for these three tables
 *
 * Deferred to later phases:
 *   - agent_tasks, module_locks, deploy_mutex (Fas 0.4)
 *   - reports, report_threads, report_artifacts (Fas 1.x)
 *   - stored procedures (Fas 0.4: fence_and_transition, refresh_task, ...)
 *
 * Reversibility: down() drops tables in FK-reverse order. citext is
 * intentionally left installed (idempotent, may be shared with other schemas).
 */
export class CoreTables1712700000002 implements MigrationInterface {
  name = 'CoreTables1712700000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- Extensions ---
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS citext;`);

    // --- users table ---
    await queryRunner.query(`
      CREATE TABLE users (
        id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email                 citext NOT NULL UNIQUE,
        password_hash         text NOT NULL,
        role                  user_role_enum NOT NULL,
        two_factor_secret     text NULL,
        two_factor_enrolled   boolean NOT NULL DEFAULT false,
        two_factor_required   boolean NOT NULL DEFAULT true,
        failed_login_count    int NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
        locked_until          timestamptz NULL,
        last_login_at         timestamptz NULL,
        created_at            timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT users_email_has_at CHECK (email::text LIKE '%@%'),
        CONSTRAINT users_password_hash_nonempty CHECK (char_length(password_hash) > 0)
      );
    `);

    // --- sessions table ---
    await queryRunner.query(`
      CREATE TABLE sessions (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        issued_at     timestamptz NOT NULL DEFAULT now(),
        expires_at    timestamptz NOT NULL,
        last_seen_at  timestamptz NOT NULL DEFAULT now(),
        revoked_at    timestamptz NULL,
        ip_addr       inet NULL,
        user_agent    text NULL,
        CONSTRAINT sessions_expires_after_issue CHECK (expires_at > issued_at),
        CONSTRAINT sessions_last_seen_after_issue CHECK (last_seen_at >= issued_at)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX idx_sessions_user_expires ON sessions(user_id, expires_at);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_sessions_active ON sessions(user_id, last_seen_at) WHERE revoked_at IS NULL;
    `);

    // --- projects table ---
    // Notes on schema choices:
    //  - host_base_url enforces https:// prefix only at DB level; private-IP
    //    blocking is deferred to application validation (complex regex
    //    belongs in code, not DB checks)
    //  - github_app_install_id is the installation id returned by GitHub
    //    during App authorization; the App private key itself is file-backed
    //    per §19 D13 and is NOT stored in this table
    //  - host_token_hmac / deploy_token_hmac are HMAC-SHA256 digests; the
    //    raw tokens are shown once at registration and never stored in DB
    //  - branch_protection_* fields are populated by the compliance module
    //    after a successful GitHub API check
    await queryRunner.query(`
      CREATE TABLE projects (
        id                                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug                                varchar(64) NOT NULL UNIQUE,
        name                                varchar(255) NOT NULL,
        status                              project_status_enum NOT NULL DEFAULT 'active',
        host_base_url                       varchar(512) NOT NULL,
        host_health_path                    varchar(255) NOT NULL DEFAULT '/devloop-host/healthz',
        github_app_install_id               bigint NOT NULL,
        github_owner                        varchar(128) NOT NULL,
        github_repo                         varchar(128) NOT NULL,
        github_default_branch               varchar(128) NOT NULL DEFAULT 'main',
        host_token_id                       varchar(32) NOT NULL UNIQUE,
        host_token_hmac                     bytea NOT NULL,
        deploy_token_id                     varchar(32) NOT NULL UNIQUE,
        deploy_token_hmac                   bytea NOT NULL,
        deploy_allowlist_paths              text[] NOT NULL DEFAULT '{}',
        deploy_denied_paths                 text[] NOT NULL DEFAULT '{}',
        branch_protection_verified_at       timestamptz NULL,
        branch_protection_required_checks   text[] NOT NULL DEFAULT '{}',
        created_at                          timestamptz NOT NULL DEFAULT now(),
        created_by                          uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT projects_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
        CONSTRAINT projects_host_base_url_https CHECK (host_base_url LIKE 'https://%'),
        CONSTRAINT projects_host_token_hmac_len CHECK (octet_length(host_token_hmac) = 32),
        CONSTRAINT projects_deploy_token_hmac_len CHECK (octet_length(deploy_token_hmac) = 32),
        CONSTRAINT projects_github_install_id_positive CHECK (github_app_install_id > 0),
        CONSTRAINT projects_github_owner_nonempty CHECK (char_length(github_owner) > 0),
        CONSTRAINT projects_github_repo_nonempty CHECK (char_length(github_repo) > 0)
      );
    `);
    // Plain index on `status`: lets admin queries filter "all active projects"
    // efficiently without the redundancy of indexing the PK column under a
    // partial predicate. Low cardinality but correct shape for the access path.
    await queryRunner.query(`
      CREATE INDEX idx_projects_status ON projects(status);
    `);
    // Index on FK column `created_by` — needed for efficient cascading checks
    // when a user is deleted (though we use ON DELETE RESTRICT, so the check
    // still runs) and for "projects created by this user" lookups.
    await queryRunner.query(`
      CREATE INDEX idx_projects_created_by ON projects(created_by);
    `);

    // --- Grants per §19 D26 for devloop_api ---
    // users: SELECT only (auth module reads for login; writes happen via
    //        admin-only endpoints that will use SECURITY DEFINER in 0.4)
    await queryRunner.query(`GRANT SELECT ON users TO devloop_api;`);

    // sessions: SELECT + INSERT (issue new session) + UPDATE(last_seen_at, revoked_at)
    await queryRunner.query(`GRANT SELECT, INSERT ON sessions TO devloop_api;`);
    await queryRunner.query(`GRANT UPDATE (last_seen_at, revoked_at) ON sessions TO devloop_api;`);

    // projects: SELECT + UPDATE(status, branch_protection_verified_at, branch_protection_required_checks)
    // (project create/delete is admin flow, added in 0.4 via stored proc)
    await queryRunner.query(`GRANT SELECT ON projects TO devloop_api;`);
    await queryRunner.query(`
      GRANT UPDATE (status, branch_protection_verified_at, branch_protection_required_checks)
      ON projects TO devloop_api;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revoke grants first (defensive; DROP TABLE would implicitly remove them)
    await queryRunner.query(`REVOKE ALL ON projects FROM devloop_api;`);
    await queryRunner.query(`REVOKE ALL ON sessions FROM devloop_api;`);
    await queryRunner.query(`REVOKE ALL ON users FROM devloop_api;`);

    // Drop in FK-reverse order
    await queryRunner.query(`DROP TABLE IF EXISTS projects;`);
    await queryRunner.query(`DROP TABLE IF EXISTS sessions;`);
    await queryRunner.query(`DROP TABLE IF EXISTS users;`);

    // citext is intentionally left installed on down() — idempotent and
    // potentially shared. Same policy as pgcrypto in migration 001.
  }
}
