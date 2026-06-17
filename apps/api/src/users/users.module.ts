import { Module } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { BlobStoreModule } from '../blob/blob-store.module.js';
import { GdprController } from './gdpr.controller.js';
import { GdprService } from './gdpr.service.js';
import { MeController } from './me.controller.js';
import { UserService } from './user.service.js';
import { UsersController } from './users.controller.js';

@Module({
  imports: [BlobStoreModule],
  controllers: [MeController, UsersController, GdprController],
  // AuditService added directly (not via AuditModule) to avoid a circular import —
  // AuditModule imports UsersModule for its AuthSessionController.
  providers: [UserService, GdprService, AuditService],
  exports: [UserService],
})
export class UsersModule {}
