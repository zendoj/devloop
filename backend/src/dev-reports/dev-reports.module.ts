import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DevReport } from './entities/dev-report.entity';
import { DevReportFile } from './entities/dev-report-file.entity';
import { DevReportsService } from './dev-reports.service';
import { DevReportsController } from './dev-reports.controller';

@Module({
  imports: [TypeOrmModule.forFeature([DevReport, DevReportFile])],
  controllers: [DevReportsController],
  providers: [DevReportsService],
})
export class DevReportsModule {}
