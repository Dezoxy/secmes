import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { PlansService } from './plans.service.js';

@Module({
  imports: [AuditModule],
  providers: [PlansService],
  exports: [PlansService],
})
export class PlansModule {}
