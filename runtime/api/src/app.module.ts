import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { HostReportsModule } from './host-reports/host-reports.module';
import { ProjectsModule } from './projects/projects.module';
import { ReportsModule } from './reports/reports.module';
import { TasksModule } from './tasks/tasks.module';

/**
 * Root module. Fas 0.9 wires the DB data source, file-backed secrets,
 * and auth. Fas 1b adds projects, Fas 1c adds reports intake.
 */
@Module({
  imports: [
    ConfigModule,
    DbModule,
    AuthModule,
    ProjectsModule,
    ReportsModule,
    TasksModule,
    HostReportsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
