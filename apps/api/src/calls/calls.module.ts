import { Module } from '@nestjs/common';

import { MessagingModule } from '../messaging/messaging.module.js';
import { RealtimeBusModule } from '../realtime/realtime-bus.module.js';
import { loadTurnSharedSecret, TURN_SHARED_SECRET } from './calls.config.js';
import { CallsAuthzService } from './calls-authz.service.js';
import { CallsController } from './calls.controller.js';
import { CallsService } from './calls.service.js';

@Module({
  imports: [MessagingModule, RealtimeBusModule],
  controllers: [CallsController],
  providers: [
    {
      provide: TURN_SHARED_SECRET,
      useFactory: loadTurnSharedSecret,
    },
    CallsAuthzService,
    CallsService,
  ],
  exports: [CallsAuthzService],
})
export class CallsModule {}
