import { Module } from '@nestjs/common';
import { DbSchemaController } from './db-schema.controller';

@Module({
  controllers: [DbSchemaController],
})
export class DbSchemaModule {}
