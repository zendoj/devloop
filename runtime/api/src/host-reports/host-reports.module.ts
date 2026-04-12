import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { ReportsModule } from '../reports/reports.module';
import { TasksService } from '../tasks/tasks.service';
import { HostAuthGuard } from './host-auth.guard';
import { HostReportsController } from './host-reports.controller';

// TasksService is pulled in directly (not via TasksModule) so
// the host-auth'd reject endpoint can reach it without dragging
// the session-auth'd TasksController into this feature. DbModule
// is already imported which satisfies TasksService's only
// dependency (DATA_SOURCE).
@Module({
  imports: [DbModule, ReportsModule],
  controllers: [HostReportsController],
  providers: [HostAuthGuard, TasksService],
})
export class HostReportsModule {}
