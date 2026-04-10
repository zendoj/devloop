import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';

/**
 * Root module. Fas 0.1 scaffolding.
 * Additional feature modules (auth, projects, reports, orchestrator, ...)
 * are added in later phases per ARCHITECTURE.md §3.1.2.
 */
@Module({
  imports: [],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
