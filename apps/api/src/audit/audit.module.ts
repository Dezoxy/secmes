import { Module } from '@nestjs/common';

import { UsersModule } from '../users/users.module.js';
import { AuditService } from './audit.service.js';
import { AuthSessionController } from './auth-session.controller.js';

// The global JwtAuthGuard (from AuthModule) protects this controller. UsersModule provides
// UserService for JIT provisioning at login.
@Module({
  imports: [UsersModule],
  controllers: [AuthSessionController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
