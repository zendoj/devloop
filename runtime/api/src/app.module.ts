import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { ProjectsModule } from './projects/projects.module';

/**
 * Root module. Fas 0.9 wires the DB data source, file-backed secrets,
 * and auth. Fas 1b adds the projects list endpoint.
 */
@Module({
  imports: [ConfigModule, DbModule, AuthModule, ProjectsModule],
  controllers: [HealthController],
})
export class AppModule {}
