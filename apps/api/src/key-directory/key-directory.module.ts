import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { KeyDirectoryController } from './key-directory.controller.js';
import { KeyDirectoryService } from './key-directory.service.js';

// Protected by the global JwtAuthGuard (AuthModule). Stores PUBLIC key material only.
// Imports AuditModule so claims are audited (pool-drain detectability).
@Module({
  imports: [AuditModule],
  controllers: [KeyDirectoryController],
  providers: [KeyDirectoryService],
  exports: [KeyDirectoryService],
})
export class KeyDirectoryModule {}
