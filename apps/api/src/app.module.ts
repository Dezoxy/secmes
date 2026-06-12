import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AdminModule } from './admin/admin.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BillingModule } from './billing/billing.module.js';
import { KeyBackupModule } from './key-backup/key-backup.module.js';
import { KeyDirectoryModule } from './key-directory/key-directory.module.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { OperatorModule } from './operator/operator.module.js';
import { PlansModule } from './plans/plans.module.js';
import { PushModule } from './push/push.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { SsoModule } from './sso/sso.module.js';
import { TenantsModule } from './tenants/tenants.module.js';
import { UsersModule } from './users/users.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';

@Module({
  imports: [
    AdminModule,
    AuthModule,
    BillingModule,
    UsersModule,
    AuditModule,
    KeyDirectoryModule,
    KeyBackupModule,
    MessagingModule,
    OperatorModule,
    PlansModule,
    PushModule,
    RealtimeModule,
    SsoModule,
    TenantsModule,
    WebhooksModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
