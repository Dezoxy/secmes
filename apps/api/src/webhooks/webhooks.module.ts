import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { WebhooksController } from './webhooks.controller.js';

@Module({
  imports: [BillingModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
