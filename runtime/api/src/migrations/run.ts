import 'reflect-metadata';
import { dataSource } from '../data-source';

/**
 * Migration CLI entry point.
 *
 * Usage (as devloop-admin OS user so peer auth maps to devloop_owner):
 *   sudo -u devloop-admin DEVLOOP_DB_USER=devloop_owner npm run migration:run
 *   sudo -u devloop-admin DEVLOOP_DB_USER=devloop_owner npm run migration:revert
 *   sudo -u devloop-admin DEVLOOP_DB_USER=devloop_owner npm run migration:status
 *
 * This is the only command that should ever use the devloop_owner role.
 * Runtime services use devloop_api (or devloop_orch, devloop_rev, etc. in
 * later phases) and never have privileges to run migrations.
 */

type Command = 'up' | 'down' | 'status';

function parseCommand(argv: string[]): Command {
  const cmd = argv[2];
  if (cmd === 'up' || cmd === 'down' || cmd === 'status') {
    return cmd;
  }
  // eslint-disable-next-line no-console
  console.error(
    `Usage: migration:run <up|down|status>  (got '${cmd ?? ''}')`,
  );
  process.exit(2);
}

async function main(): Promise<void> {
  // Safety: the runner itself refuses to start if the DB user is anything
  // other than devloop_owner. Runtime services must not be used here.
  const dbUser = process.env['DEVLOOP_DB_USER'];
  if (dbUser !== 'devloop_owner') {
    // eslint-disable-next-line no-console
    console.error(
      `[devloop-migrations] FATAL: migrations require DEVLOOP_DB_USER=devloop_owner (got '${dbUser ?? ''}'). Refusing to run.`,
    );
    process.exit(1);
  }

  const command = parseCommand(process.argv);

  try {
    await dataSource.initialize();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[devloop-migrations] failed to connect:', err);
    process.exit(1);
  }

  try {
    switch (command) {
      case 'up': {
        // eslint-disable-next-line no-console
        console.log('[devloop-migrations] running pending migrations...');
        const executed = await dataSource.runMigrations({
          transaction: 'each',
        });
        if (executed.length === 0) {
          // eslint-disable-next-line no-console
          console.log('[devloop-migrations] no pending migrations.');
        } else {
          for (const m of executed) {
            // eslint-disable-next-line no-console
            console.log(`[devloop-migrations]   ✓ ${m.name}`);
          }
        }
        break;
      }
      case 'down': {
        // Resolve the name of the migration that will be reverted BEFORE calling
        // undoLastMigration, so we can log it explicitly for observability.
        const lastExecutedRow = (await dataSource.query(
          `SELECT name FROM devloop_migrations ORDER BY id DESC LIMIT 1`,
        )) as { name: string }[];
        const lastName = lastExecutedRow[0]?.name ?? '(none)';
        // eslint-disable-next-line no-console
        console.log(
          `[devloop-migrations] reverting last migration: ${lastName}`,
        );
        await dataSource.undoLastMigration({ transaction: 'each' });
        // eslint-disable-next-line no-console
        console.log(`[devloop-migrations]   ✓ reverted ${lastName}`);
        break;
      }
      case 'status': {
        // TypeORM's MigrationInterface.name is `string | undefined`; filter any
        // unnamed migrations (there shouldn't be any, but strict types require it).
        const all: string[] = dataSource.migrations
          .map((m) => m.name)
          .filter((n): n is string => typeof n === 'string');
        // On a pristine database, devloop_migrations does not yet exist.
        // Treat that case as "no migrations applied" rather than erroring out.
        const tableExistsRow = (await dataSource.query(
          `SELECT to_regclass('public.devloop_migrations') AS tbl`,
        )) as { tbl: string | null }[];
        const tableExists = tableExistsRow[0]?.tbl != null;
        let executedSet: Set<string>;
        if (tableExists) {
          const executedRows = (await dataSource.query(
            `SELECT name FROM devloop_migrations ORDER BY id ASC`,
          )) as { name: string }[];
          executedSet = new Set<string>(executedRows.map((r) => r.name));
        } else {
          executedSet = new Set<string>();
        }
        // eslint-disable-next-line no-console
        console.log(
          `[devloop-migrations] status${tableExists ? '' : ' (pristine DB — no migrations applied yet)'}:`,
        );
        for (const name of all) {
          const mark = executedSet.has(name) ? '✓' : '·';
          // eslint-disable-next-line no-console
          console.log(`  ${mark} ${name}`);
        }
        break;
      }
      default: {
        const _exhaustive: never = command;
        throw new Error(`Unhandled command: ${String(_exhaustive)}`);
      }
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[devloop-migrations] unhandled error:', err);
  process.exit(1);
});
