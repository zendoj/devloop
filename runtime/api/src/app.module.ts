import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';

/**
 * Root module. Fas 0.9 wires the DB data source, file-backed secrets,
 * and auth.
 */
@Module({
  imports: [ConfigModule, DbModule, AuthModule],
  controllers: [HealthController],
})
export class AppModule {}
