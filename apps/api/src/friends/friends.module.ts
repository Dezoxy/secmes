import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { UsersModule } from '../users/users.module.js';
import { FriendsController } from './friends.controller.js';
import { FriendsService } from './friends.service.js';

// Server-backed friend graph (contact-list recovery). Protected by the global JwtAuthGuard (AuthModule).
// Imports UsersModule for UserService.lookupByArgusId (the shared exact-match discovery — not forked)
// and AuditModule for the friend-request probe audit trail.
@Module({
  imports: [AuditModule, UsersModule],
  controllers: [FriendsController],
  providers: [FriendsService],
})
export class FriendsModule {}
