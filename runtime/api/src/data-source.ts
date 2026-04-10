import * as path from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';

/**
 * TypeORM DataSource for the DevLoop API.
 *
 * Auth model (ARCHITECTURE.md §4.1, §11, §19 D20):
 *   - Connection uses Unix domain socket peer authentication
 *   - The OS user running this process is mapped to a PG role via pg_ident.conf
 *   - Migrations: run as devloop-admin OS user → devloop_owner PG role
 *   - Runtime:    run as devloop-api   OS user → devloop_api   PG role
 *   - NO password is used; NO TCP connection; NO TLS layer on top
 *
 * Invariant: synchronize is HARDCODED to false. It cannot be overridden by env.
 * The startup guard in main.ts rejects any env var that attempts to flip it.
 */

const DEFAULT_SOCKET_DIR = '/var/run/postgresql';
const DEFAULT_DB_NAME = 'devloop';

function readDataSourceOptions(): DataSourceOptions {
  const socketDir = process.env['DEVLOOP_DB_SOCKET_DIR'] ?? DEFAULT_SOCKET_DIR;
  const database = process.env['DEVLOOP_DB_NAME'] ?? DEFAULT_DB_NAME;
  const username = process.env['DEVLOOP_DB_USER'];

  if (!username) {
    throw new Error(
      'DEVLOOP_DB_USER is required. Set it to devloop_owner (for migrations) or devloop_api (for runtime).',
    );
  }

  // Detect whether we are running from compiled dist/ or from source via ts-node.
  // This avoids loading both .ts and .js copies of the same migration, which would
  // cause a "Duplicate migrations" error from TypeORM.
  const isCompiled = __filename.endsWith('.js');
  const migrationsGlob = isCompiled
    ? path.join(__dirname, 'migrations', '[0-9]*.js')
    : path.join(__dirname, 'migrations', '[0-9]*.ts');

  // Peer auth via Unix socket: pg driver treats `host` starting with '/' as a
  // socket directory. TypeORM passes this through to node-postgres.
  return {
    type: 'postgres',
    host: socketDir,
    database,
    username,
    // No password field at all — peer auth.
    synchronize: false,
    dropSchema: false,
    migrationsRun: false,
    logging: process.env['DEVLOOP_DB_LOGGING'] === 'true' ? 'all' : ['error'],
    entities: [],
    migrations: [migrationsGlob],
    migrationsTableName: 'devloop_migrations',
    extra: {
      // Conservative connection pool for MVP. Tune in Fas 7 hardening.
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    },
  };
}

export const dataSourceOptions = readDataSourceOptions();

export const dataSource = new DataSource(dataSourceOptions);
