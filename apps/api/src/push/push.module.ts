import { Module } from '@nestjs/common';

import { PushController } from './push.controller.js';
import { PushService, VAPID_CONFIG } from './push.service.js';
import { loadVapidConfig } from './push-config.js';

// Stores and fans content-free VAPID push notifications. No message content touches this module.
// Protected by the global JwtAuthGuard. VAPID config is gated: when any VAPID value is missing
// the service is a no-op (same pattern as UnconfiguredBlobStore). Exports PushService so
// MessagingModule can inject it for post-commit fan-out.
@Module({
  controllers: [PushController],
  providers: [{ provide: VAPID_CONFIG, useFactory: loadVapidConfig }, PushService],
  exports: [PushService],
})
export class PushModule {}
