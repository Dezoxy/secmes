import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { KeyDirectoryModule } from './key-directory/key-directory.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [AuthModule, UsersModule, AuditModule, KeyDirectoryModule],
  controllers: [AppController],
})
export class AppModule {}
