import { Module } from '@nestjs/common';

import { MeController } from './me.controller.js';
import { UserService } from './user.service.js';
import { UsersController } from './users.controller.js';

@Module({
  controllers: [MeController, UsersController],
  providers: [UserService],
  exports: [UserService],
})
export class UsersModule {}
