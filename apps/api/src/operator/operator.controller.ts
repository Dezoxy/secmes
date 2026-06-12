import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { z } from 'zod';

import { Public } from '../auth/public.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PlansService } from '../plans/plans.service.js';
import { OperatorGuard } from './operator.guard.js';

const SetPlanBodySchema = z
  .object({
    planTier: z.enum(['free', 'pro', 'enterprise']).optional(),
    memberLimit: z.number().int().min(1).nullable().optional(),
    ssoEnabled: z.boolean().optional(),
  })
  .strict();

type SetPlanBody = z.infer<typeof SetPlanBodySchema>;

@ApiExcludeController()
@Public()
@UseGuards(OperatorGuard)
@Controller('operator/tenants')
export class OperatorController {
  constructor(private readonly plans: PlansService) {}

  @Get(':id/plan')
  async getPlan(@Param('id', ParseUUIDPipe) tenantId: string) {
    return this.plans.getPlan(tenantId);
  }

  @Patch(':id/plan')
  @HttpCode(204)
  async setPlan(
    @Param('id', ParseUUIDPipe) tenantId: string,
    @Body(new ZodValidationPipe(SetPlanBodySchema)) body: SetPlanBody,
  ): Promise<void> {
    await this.plans.setPlan(tenantId, body, 'operator');
  }
}
