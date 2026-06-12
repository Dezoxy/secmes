import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';

import { AdminGuard } from '../auth/admin.guard.js';
import type { VerifiedAuth } from '../auth/auth.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PlansService } from '../plans/plans.service.js';
import { BillingService } from './billing.service.js';

/** Validate that a URL's origin matches the app base URL to prevent open redirects. */
function sameAppOrigin(url: string): boolean {
  const appBase = (process.env.APP_BASE_URL ?? 'https://app.4rgus.com').replace(/\/$/, '');
  try {
    const parsed = new URL(url);
    const expected = new URL(appBase);
    return parsed.origin === expected.origin;
  } catch {
    return false;
  }
}

const CheckoutBodySchema = z
  .object({
    planTier: z.enum(['pro', 'enterprise']),
    successUrl: z.string().url(),
    cancelUrl: z.string().url(),
  })
  .strict()
  .refine((b) => sameAppOrigin(b.successUrl), {
    message: 'successUrl must be on the app domain',
    path: ['successUrl'],
  })
  .refine((b) => sameAppOrigin(b.cancelUrl), {
    message: 'cancelUrl must be on the app domain',
    path: ['cancelUrl'],
  });

const PortalBodySchema = z
  .object({
    returnUrl: z.string().url(),
  })
  .strict()
  .refine((b) => sameAppOrigin(b.returnUrl), {
    message: 'returnUrl must be on the app domain',
    path: ['returnUrl'],
  });

type CheckoutBody = z.infer<typeof CheckoutBodySchema>;
type PortalBody = z.infer<typeof PortalBodySchema>;

class CheckoutUrlDto {
  @ApiProperty({ description: 'Stripe-hosted checkout URL', format: 'uri' }) url!: string;
}

class PortalUrlDto {
  @ApiProperty({ description: 'Stripe Billing Portal URL', format: 'uri' }) url!: string;
}

class BillingStatusDto {
  @ApiProperty({ enum: ['free', 'pro', 'enterprise'] }) tier!: string;
  @ApiProperty({ nullable: true, type: 'integer' }) memberLimit!: number | null;
  @ApiProperty() ssoEnabled!: boolean;
  @ApiProperty({ type: 'integer' }) memberCount!: number;
  @ApiProperty({
    enum: ['active', 'trialing', 'past_due', 'canceled', 'incomplete'],
    nullable: true,
    type: 'string',
  })
  subscriptionStatus!: string | null;
}

@ApiTags('billing')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly plans: PlansService,
  ) {}

  @Post('checkout')
  @ApiOperation({
    summary: 'Create a Stripe Checkout session to subscribe to Pro or Enterprise',
    operationId: 'billingCheckout',
  })
  @ApiOkResponse({ description: 'Stripe-hosted checkout URL', type: CheckoutUrlDto })
  @ApiForbiddenResponse({ description: 'admin role required' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async createCheckout(
    @CurrentAuth() auth: VerifiedAuth,
    @Body(new ZodValidationPipe(CheckoutBodySchema)) body: CheckoutBody,
  ): Promise<CheckoutUrlDto> {
    const tenantName = await this.plans.getTenantName(auth.tenantId);
    const url = await this.billing.createCheckoutSession(
      auth.tenantId,
      body.planTier,
      tenantName,
      body.successUrl,
      body.cancelUrl,
    );
    return { url };
  }

  @Post('portal')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Create a Stripe Billing Portal session to manage the subscription',
    operationId: 'billingPortal',
  })
  @ApiOkResponse({ description: 'Stripe Billing Portal URL', type: PortalUrlDto })
  @ApiForbiddenResponse({ description: 'admin role required' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async createPortal(
    @CurrentAuth() auth: VerifiedAuth,
    @Body(new ZodValidationPipe(PortalBodySchema)) body: PortalBody,
  ): Promise<PortalUrlDto> {
    const url = await this.billing.createPortalSession(auth.tenantId, body.returnUrl);
    return { url };
  }

  @Get('status')
  @ApiOperation({
    summary: 'Get the current billing/plan status for the tenant',
    operationId: 'billingStatus',
  })
  @ApiOkResponse({ description: 'billing and plan status', type: BillingStatusDto })
  @ApiForbiddenResponse({ description: 'admin role required' })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  async getStatus(@CurrentAuth() auth: VerifiedAuth): Promise<BillingStatusDto> {
    const plan = await this.plans.getPlan(auth.tenantId);
    return {
      tier: plan.tier,
      memberLimit: plan.memberLimit,
      ssoEnabled: plan.ssoEnabled,
      memberCount: plan.memberCount,
      subscriptionStatus: plan.subscriptionStatus,
    };
  }
}
