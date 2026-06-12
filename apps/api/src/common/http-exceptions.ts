import { HttpException, HttpStatus } from '@nestjs/common';

/** 402 — the caller's plan doesn't include this feature. Upgrade to unlock. */
export class PaymentRequiredException extends HttpException {
  constructor(message = 'Plan upgrade required') {
    super(message, HttpStatus.PAYMENT_REQUIRED);
  }
}
