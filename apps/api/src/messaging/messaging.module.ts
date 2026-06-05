import { Module } from '@nestjs/common';

import { MessagingController } from './messaging.controller.js';
import { MessagingService } from './messaging.service.js';

// Protected by the global JwtAuthGuard (AuthModule). Stores CIPHERTEXT ONLY; enforces conversation
// membership before accepting a message (the intra-tenant authz the schema/RLS deferred to this layer).
@Module({
  controllers: [MessagingController],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
