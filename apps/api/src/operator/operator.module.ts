import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module.js';
import { OperatorController } from './operator.controller.js';

@Module({
  imports: [PlansModule],
  controllers: [OperatorController],
})
export class OperatorModule {}
