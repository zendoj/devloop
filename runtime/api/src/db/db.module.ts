import { Global, Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { buildDataSource } from '../data-source';

/**
 * DbModule — single TypeORM DataSource provider shared across all feature
 * modules. We do not use @nestjs/typeorm here: the runtime uses raw SQL
 * through DataSource.query() for every write path (to keep ORM magic out
 * of the reviewer's way and to reuse the exact same string-for-string
 * stored-procedure calls that the integration tests exercise).
 *
 * The DataSource is built eagerly and initialized once at module startup.
 * If initialization fails, the app crashes at boot — there is no lazy
 * reconnect logic here because Nest's lifecycle guarantees the module is
 * only brought online after init resolves.
 */
export const DATA_SOURCE = Symbol('DATA_SOURCE');

@Global()
@Module({
  providers: [
    {
      provide: DATA_SOURCE,
      useFactory: async (): Promise<DataSource> => {
        const ds = buildDataSource();
        await ds.initialize();
        return ds;
      },
    },
  ],
  exports: [DATA_SOURCE],
})
export class DbModule {}
