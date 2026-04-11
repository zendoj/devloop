import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { ClassifierService } from './classifier.service';

@Module({
  imports: [DbModule],
  providers: [ClassifierService],
  exports: [ClassifierService],
})
export class OrchestratorModule {}
