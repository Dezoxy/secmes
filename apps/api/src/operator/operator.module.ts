import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module.js';
import { SsoModule } from '../sso/sso.module.js';
import { OperatorController } from './operator.controller.js';

@Module({
  imports: [PlansModule, SsoModule],
  controllers: [OperatorController],
})
export class OperatorModule {}
