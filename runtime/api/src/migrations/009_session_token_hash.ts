import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 009 — session token hashing.
 *
 * Fas 0.9 adds a `token_hash` column to public.sessions so we store
 * a cryptographic hash of the session token, not the token itself.
 * The cookie carries the raw random token; the server hashes it on
 * every request and looks up the row by hash. This means a DB leak
 * does not give an attacker usable session cookies.
 *
 * The legacy `id` column stays as the primary key (surrogate) so FKs
 * and audit joins keep working, but it is no longer the token.
 *
 * Design notes:
 *   - token_hash is SHA-256 of the raw token (32 bytes, bytea). Raw
 *     token is 32 random bytes, base64url-encoded into the cookie.
 *   - Partial unique index on token_hash WHERE revoked_at IS NULL
 *     enforces "no two active sessions share a token" without
 *     blocking historical (revoked) rows.
 *   - Non-partial unique would also work but forces revoked rows to
 *     retain their hash forever; the partial index is slightly
 *     friendlier for future rotation / purge flows.
 *
 * Grants: devloop_api already has SELECT + INSERT on sessions from
 * migration 002, and UPDATE on (last_seen_at, revoked_at). No new
 * grants required — token_hash is populated at INSERT time and never
 * updated.
 */
export class SessionTokenHash1712700000009 implements MigrationInterface {
  name = 'SessionTokenHash1712700000009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add the column nullable first so we can backfill any existing rows.
    // In practice the table is empty at this phase (Fas 0.9 is where auth
    // starts to exist) but we code defensively.
    await queryRunner.query(`
      ALTER TABLE public.sessions
        ADD COLUMN token_hash bytea NULL;
    `);

    // Backfill any pre-existing rows with a placeholder that cannot be
    // matched by any real token lookup: 32 bytes of 0xFF. We then mark
    // the row as revoked so nobody can accidentally hit a session that
    // has no meaningful token. In practice this backfill touches zero
    // rows today but the migration must be idempotent if re-applied to
    // a non-empty schema.
    await queryRunner.query(`
      UPDATE public.sessions
         SET token_hash = decode(repeat('ff', 32), 'hex'),
             revoked_at = COALESCE(revoked_at, now())
       WHERE token_hash IS NULL;
    `);

    await queryRunner.query(`
      ALTER TABLE public.sessions
        ALTER COLUMN token_hash SET NOT NULL;
    `);

    // SHA-256 is 32 bytes. Enforce the length explicitly so the server
    // cannot insert a mis-sized hash and still lose lookups silently.
    await queryRunner.query(`
      ALTER TABLE public.sessions
        ADD CONSTRAINT sessions_token_hash_length
        CHECK (octet_length(token_hash) = 32);
    `);

    // Partial unique: no two active sessions share a token hash.
    // Revoked sessions keep their hash for audit but are excluded
    // from the uniqueness check.
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_sessions_token_hash_active
        ON public.sessions(token_hash)
        WHERE revoked_at IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS public.idx_sessions_token_hash_active;`);
    await queryRunner.query(`
      ALTER TABLE public.sessions
        DROP CONSTRAINT IF EXISTS sessions_token_hash_length;
    `);
    await queryRunner.query(`
      ALTER TABLE public.sessions
        DROP COLUMN IF EXISTS token_hash;
    `);
  }
}
