import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { ClassifierService } from './classifier.service';
import { PlannerService } from './planner.service';

@Module({
  imports: [DbModule],
  providers: [ClassifierService, PlannerService],
  exports: [ClassifierService, PlannerService],
})
export class OrchestratorModule {}
