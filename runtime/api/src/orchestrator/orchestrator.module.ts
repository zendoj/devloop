import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { ClassifierService } from './classifier.service';

// PlannerService is no longer constructed by Nest — the planner
// now runs from the worker-manager standalone script just
// before Claude spawns. Removing it from providers prevents Nest
// from wiring an instance we'd only leave idle.
@Module({
  imports: [DbModule],
  providers: [ClassifierService],
  exports: [ClassifierService],
})
export class OrchestratorModule {}
