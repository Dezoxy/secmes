import { Controller, Get, NotFoundException } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { UserService } from './user.service.js';

class MeResponse {
  @ApiProperty()
  userId!: string;

  @ApiProperty()
  tenantId!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ type: String, nullable: true })
  displayName!: string | null;
}

@ApiTags('users')
@ApiBearerAuth()
@Controller()
export class MeController {
  constructor(private readonly users: UserService) {}

  /** The authenticated user, resolved inside the verified tenant's RLS context. */
  @Get('me')
  @ApiOperation({ summary: 'Current authenticated user', operationId: 'getMe' })
  @ApiOkResponse({ type: MeResponse })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  @ApiNotFoundResponse({ description: 'authenticated identity not provisioned in this tenant' })
  async me(@CurrentAuth() auth: VerifiedAuth): Promise<MeResponse> {
    // tenantId + sub both come from the verified token; getByAuth runs under RLS for that tenant,
    // so a user only ever resolves within their own tenant. Provisioning happens at login.
    const user = await this.users.getByAuth(auth);
    if (!user) throw new NotFoundException('user not provisioned');
    return {
      userId: user.id,
      tenantId: auth.tenantId,
      email: user.email,
      displayName: user.displayName,
    };
  }
}
