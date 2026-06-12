import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

@Module({
  imports: [AuditModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
