import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DbModule } from '../db/db.module';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';

@Module({
  imports: [DbModule, AuthModule],
  controllers: [SystemController],
  providers: [SystemService],
})
export class SystemModule {}
