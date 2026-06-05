import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { KeyBackupController } from './key-backup.controller.js';
import { KeyBackupService } from './key-backup.service.js';

// Protected by the global JwtAuthGuard. Stores opaque sealed ciphertext only (crypto-blind).
// Imports AuditModule so restore-fetches are audited.
@Module({
  imports: [AuditModule],
  controllers: [KeyBackupController],
  providers: [KeyBackupService],
  exports: [KeyBackupService],
})
export class KeyBackupModule {}
