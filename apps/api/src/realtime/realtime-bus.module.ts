import { Logger, Module } from '@nestjs/common';

import { InProcessRealtimeBus } from './in-process-realtime-bus.js';
import { RealtimeBus } from './realtime-bus.js';
import { RedisRealtimeBus } from './redis-realtime-bus.js';

// Shared, imported by BOTH the messaging module (publishes) and the realtime module (subscribes) — kept
// in its own module so neither depends on the other (no cycle). Selects the cross-pod Redis bus when
// REDIS_URL is set, else the single-pod in-process bus (dev / tests / single replica).
@Module({
  providers: [
    {
      provide: RealtimeBus,
      useFactory: (): RealtimeBus => {
        const url = process.env.REDIS_URL;
        if (url) {
          new Logger('RealtimeBus').log('using Redis backplane for cross-pod delivery');
          return new RedisRealtimeBus(url);
        }
        return new InProcessRealtimeBus();
      },
    },
  ],
  exports: [RealtimeBus],
})
export class RealtimeBusModule {}
