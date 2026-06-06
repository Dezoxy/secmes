import { Module } from '@nestjs/common';

import { RealtimeBusModule } from '../realtime/realtime-bus.module.js';
import { MessagingController } from './messaging.controller.js';
import { MessagingService } from './messaging.service.js';
import { SyncController } from './sync.controller.js';

// Protected by the global JwtAuthGuard (AuthModule). Stores CIPHERTEXT ONLY; enforces conversation
// membership before accepting a message (the intra-tenant authz the schema/RLS deferred to this layer).
// Imports RealtimeBusModule so a stored message is announced for real-time fan-out (gateway, 28).
// SyncController serves the cross-conversation catch-up (30).
@Module({
  imports: [RealtimeBusModule],
  controllers: [MessagingController, SyncController],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
