import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { KeyBackupModule } from './key-backup/key-backup.module.js';
import { KeyDirectoryModule } from './key-directory/key-directory.module.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { PushModule } from './push/push.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    AuthModule,
    UsersModule,
    AuditModule,
    KeyDirectoryModule,
    KeyBackupModule,
    MessagingModule,
    PushModule,
    RealtimeModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
