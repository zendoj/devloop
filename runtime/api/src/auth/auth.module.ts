import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { AuthController } from './auth.controller';
import { SessionGuard } from './guards/session.guard';
import { AuthService } from './services/auth.service';
import { Challenge2faService } from './services/challenge-2fa.service';
import { DataEncryptionService } from './services/data-encryption.service';
import { PasswordService } from './services/password.service';
import { SessionService } from './services/session.service';
import { TotpService } from './services/totp.service';

@Module({
  imports: [DbModule],
  controllers: [AuthController],
  providers: [
    PasswordService,
    SessionService,
    TotpService,
    DataEncryptionService,
    Challenge2faService,
    AuthService,
    SessionGuard,
  ],
  exports: [PasswordService, SessionService, SessionGuard],
})
export class AuthModule {}
