import { Module } from '@nestjs/common';

import { MeController } from './me.controller.js';
import { UserService } from './user.service.js';

@Module({
  controllers: [MeController],
  providers: [UserService],
  exports: [UserService],
})
export class UsersModule {}
