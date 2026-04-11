import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { ReportsModule } from '../reports/reports.module';
import { HostAuthGuard } from './host-auth.guard';
import { HostReportsController } from './host-reports.controller';

@Module({
  imports: [DbModule, ReportsModule],
  controllers: [HostReportsController],
  providers: [HostAuthGuard],
})
export class HostReportsModule {}
