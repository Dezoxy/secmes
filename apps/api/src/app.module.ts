import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller.js';
import { AdminModule } from './admin/admin.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { DevicesModule } from './devices/devices.module.js';
import { CallsModule } from './calls/calls.module.js';
import { FriendsModule } from './friends/friends.module.js';
import { KeyDirectoryModule } from './key-directory/key-directory.module.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { PushModule } from './push/push.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { TenantsModule } from './tenants/tenants.module.js';
import { UsersModule } from './users/users.module.js';
import { pinoHttpConfig } from './observability/logger.js';

@Module({
  imports: [
    LoggerModule.forRootAsync({
      useFactory: () => ({ pinoHttp: pinoHttpConfig }),
    }),
    AdminModule,
    AuthModule,
    CallsModule,
    DevicesModule,
    FriendsModule,
    UsersModule,
    AuditModule,
    KeyDirectoryModule,
    MessagingModule,
    PushModule,
    RealtimeModule,
    TenantsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
