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
  // AuditService is provided directly (it has no dependencies) rather than importing AuditModule,
  // keeping this module's wiring flat.
  providers: [UserService, GdprService, AuditService],
  exports: [UserService],
})
export class UsersModule {}
