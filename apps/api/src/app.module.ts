import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { MeController } from './users/me.controller.js';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [AppController, MeController],
})
export class AppModule {}
