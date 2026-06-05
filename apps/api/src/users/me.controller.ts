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
import { eq } from 'drizzle-orm';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { schema, withTenant } from '../db/index.js';

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
  /** The authenticated user, resolved inside the verified tenant's RLS context. */
  @Get('me')
  @ApiOperation({ summary: 'Current authenticated user', operationId: 'getMe' })
  @ApiOkResponse({ type: MeResponse })
  @ApiUnauthorizedResponse({ description: 'missing or invalid bearer token' })
  @ApiNotFoundResponse({ description: 'authenticated identity not provisioned in this tenant' })
  async me(@CurrentAuth() auth: VerifiedAuth): Promise<MeResponse> {
    // tenantId + sub both come from the verified token; the lookup runs under RLS for that tenant,
    // so a user only ever resolves within their own tenant.
    const [user] = await withTenant(auth.tenantId, async (tx) =>
      tx
        .select({
          id: schema.users.id,
          email: schema.users.email,
          displayName: schema.users.displayName,
        })
        .from(schema.users)
        .where(eq(schema.users.externalIdentityId, auth.sub))
        .limit(1),
    );
    if (!user) throw new NotFoundException('user not provisioned');
    return {
      userId: user.id,
      tenantId: auth.tenantId,
      email: user.email,
      displayName: user.displayName ?? null,
    };
  }
}
