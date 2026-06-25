import { Module } from '@nestjs/common';

import { loadTurnSharedSecret, TURN_SHARED_SECRET } from './calls.config.js';
import { CallsController } from './calls.controller.js';
import { CallsService } from './calls.service.js';

@Module({
  controllers: [CallsController],
  providers: [
    {
      provide: TURN_SHARED_SECRET,
      useFactory: loadTurnSharedSecret,
    },
    CallsService,
  ],
})
export class CallsModule {}
