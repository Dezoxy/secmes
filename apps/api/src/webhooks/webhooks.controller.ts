import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../auth/public.decorator.js';
import { BillingService } from '../billing/billing.service.js';

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(private readonly billing: BillingService) {}

  @Post('stripe')
  @Public()
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async stripeWebhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('stripe-signature') sig: string,
  ): Promise<void> {
    const rawBody = req.rawBody;
    if (!rawBody) throw new BadRequestException('raw body unavailable');
    if (!sig) throw new BadRequestException('missing stripe-signature header');

    let event;
    try {
      event = this.billing.verifyWebhookEvent(rawBody, sig);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'signature verification failed';
      this.logger.warn(`stripe webhook rejected: ${msg}`);
      throw new BadRequestException('invalid stripe signature');
    }

    // Return 200 immediately; process async so Stripe doesn't time out on slow DB writes.
    void this.billing.handleWebhookEvent(event).catch((err: unknown) => {
      this.logger.error('stripe webhook handler error', err instanceof Error ? err.stack : err);
    });
  }
}
