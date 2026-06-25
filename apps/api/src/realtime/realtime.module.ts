import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { CallsModule } from '../calls/calls.module.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { RealtimeBusModule } from './realtime-bus.module.js';
import { RealtimeGateway } from './realtime.gateway.js';

// WebSocket gateway for real-time delivery. Imports CallsModule to access CallsAuthzService,
// which holds the in-memory call-authorization map the call.signal relay path validates against.
@Module({
  imports: [AuthModule, MessagingModule, RealtimeBusModule, CallsModule],
  providers: [RealtimeGateway],
})
export class RealtimeModule {}
