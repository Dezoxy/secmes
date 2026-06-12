import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { PlansModule } from '../plans/plans.module.js';
import {
  buildZitadelManagementConfig,
  ZITADEL_MANAGEMENT_CONFIG,
} from './zitadel-management.config.js';
import { ZitadelManagementClient } from './zitadel-management.client.js';
import { SsoController } from './sso.controller.js';
import { SsoService } from './sso.service.js';

@Module({
  imports: [AuditModule, PlansModule],
  controllers: [SsoController],
  providers: [
    {
      provide: ZITADEL_MANAGEMENT_CONFIG,
      useFactory: buildZitadelManagementConfig,
    },
    ZitadelManagementClient,
    SsoService,
  ],
  exports: [SsoService],
})
export class SsoModule {}
