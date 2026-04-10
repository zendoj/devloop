import { Global, Module } from '@nestjs/common';
import { SecretsService } from './secrets.service';

/**
 * Global config module. Exposes SecretsService to every module so
 * file-backed secrets are loaded exactly once at startup and can be
 * injected wherever they are needed (data encryption, JWT signing,
 * challenge signing, etc.) without ceremony.
 */
@Global()
@Module({
  providers: [SecretsService],
  exports: [SecretsService],
})
export class ConfigModule {}
