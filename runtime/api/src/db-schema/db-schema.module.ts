import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DbModule } from '../db/db.module';
import { DbSchemaController } from './db-schema.controller';

@Module({
  imports: [DbModule, AuthModule],
  controllers: [DbSchemaController],
})
export class DbSchemaModule {}
