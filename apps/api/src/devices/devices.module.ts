import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { RealtimeBusModule } from '../realtime/realtime-bus.module.js';
import { DevicesController } from './devices.controller.js';
import { DevicesService } from './devices.service.js';

// B2: multi-device enrollment coordination. Protected by the global JwtAuthGuard (AuthModule).
// Imports AuditModule for enrollment audit trail and RealtimeBusModule for D1/D2 WS nudges.
@Module({
  imports: [AuditModule, RealtimeBusModule],
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
