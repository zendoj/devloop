import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { SecretsService } from './config/secrets.service';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';

/**
 * Root module. Fas 0.9 wires the DB data source, file-backed secrets,
 * and auth.
 */
@Module({
  imports: [DbModule, AuthModule],
  controllers: [HealthController],
  providers: [SecretsService],
})
export class AppModule {}
