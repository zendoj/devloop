import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { AuthController } from './auth.controller';
import { SessionGuard } from './guards/session.guard';
import { AuthService } from './services/auth.service';
import { PasswordService } from './services/password.service';
import { SessionService } from './services/session.service';

@Module({
  imports: [DbModule],
  controllers: [AuthController],
  providers: [PasswordService, SessionService, AuthService, SessionGuard],
  exports: [PasswordService, SessionService, SessionGuard],
})
export class AuthModule {}
