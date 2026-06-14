import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module.js';
import { SsoModule } from '../sso/sso.module.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { StripeEventStore } from './stripe-event-store.js';

@Module({
  imports: [PlansModule, SsoModule],
  controllers: [BillingController],
  providers: [BillingService, StripeEventStore],
  exports: [BillingService],
})
export class BillingModule {}
