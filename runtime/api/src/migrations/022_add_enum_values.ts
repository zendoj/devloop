import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 022 — add enum values only.
 *
 * `ALTER TYPE ADD VALUE` cannot be referenced in the same
 * transaction it's added in. Split from 023 which creates the
 * function + table + columns that actually use these values.
 */
export class AddEnumValues1712700000022 implements MigrationInterface {
  name = 'AddEnumValues1712700000022';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE public.task_status_enum ADD VALUE IF NOT EXISTS 'ready_for_test'`,
    );
    await queryRunner.query(
      `ALTER TYPE public.task_status_enum ADD VALUE IF NOT EXISTS 'accepted'`,
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Enum values cannot be removed without rebuilding the enum.
    // Leave them in place.
  }
}
