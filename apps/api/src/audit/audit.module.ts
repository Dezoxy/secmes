import { Module } from '@nestjs/common';

import { AuditService } from './audit.service.js';
import { AuthSessionController } from './auth-session.controller.js';

// The global JwtAuthGuard (from AuthModule) protects this controller; no extra import needed.
@Module({
  controllers: [AuthSessionController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
