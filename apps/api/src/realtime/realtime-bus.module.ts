import { Module } from '@nestjs/common';

import { RealtimeBus } from './realtime-bus.js';

// Shared, dependency-free bus imported by BOTH the messaging module (emits) and the realtime module
// (listens) — kept in its own module so neither of those depends on the other (no cycle).
@Module({
  providers: [RealtimeBus],
  exports: [RealtimeBus],
})
export class RealtimeBusModule {}
