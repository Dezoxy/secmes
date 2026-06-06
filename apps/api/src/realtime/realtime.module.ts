import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { RealtimeBusModule } from './realtime-bus.module.js';
import { RealtimeGateway } from './realtime.gateway.js';

// WebSocket gateway for real-time ciphertext delivery. Reuses AuthService (first-frame token auth) and
// MessagingService (membership check), and listens on the shared RealtimeBus for stored messages.
@Module({
  imports: [AuthModule, MessagingModule, RealtimeBusModule],
  providers: [RealtimeGateway],
})
export class RealtimeModule {}
