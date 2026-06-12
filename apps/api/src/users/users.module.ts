import { Module } from '@nestjs/common';

import { BlobStoreModule } from '../blob/blob-store.module.js';
import { GdprController } from './gdpr.controller.js';
import { GdprService } from './gdpr.service.js';
import { MeController } from './me.controller.js';
import { UserService } from './user.service.js';
import { UsersController } from './users.controller.js';

@Module({
  imports: [BlobStoreModule],
  controllers: [MeController, UsersController, GdprController],
  providers: [UserService, GdprService],
  exports: [UserService],
})
export class UsersModule {}
