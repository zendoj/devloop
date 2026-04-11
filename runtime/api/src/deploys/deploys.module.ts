import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DbModule } from '../db/db.module';
import { DeploysController } from './deploys.controller';
import { DeploysService } from './deploys.service';

@Module({
  imports: [DbModule, AuthModule],
  controllers: [DeploysController],
  providers: [DeploysService],
})
export class DeploysModule {}
