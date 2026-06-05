import { BadRequestException, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant } from '../db/index.js';

export interface UserRecord {
  id: string;
  email: string;
  displayName: string | null;
}

const SELECTION = {
  id: schema.users.id,
  email: schema.users.email,
  displayName: schema.users.displayName,
} as const;

@Injectable()
export class UserService {
  /**
   * JIT-provision the user from VERIFIED token claims (idempotent upsert keyed on
   * (tenant_id, external_identity_id)). Runs under the tenant's RLS context, so a token can only
   * ever create/refresh a user in its own tenant. Requires a verified `email` claim.
   */
  async provisionFromToken(auth: VerifiedAuth): Promise<UserRecord> {
    if (!auth.email) {
      throw new BadRequestException(
        'token is missing the email claim required to provision a user',
      );
    }
    const email = auth.email;
    const displayName = auth.name ?? null;
    const [user] = await withTenant(auth.tenantId, async (tx) =>
      tx
        .insert(schema.users)
        .values({
          tenantId: auth.tenantId,
          externalIdentityId: auth.sub,
          email,
          displayName,
        })
        .onConflictDoUpdate({
          target: [schema.users.tenantId, schema.users.externalIdentityId],
          // Refresh from the IdP, but don't blank a known display name when a later token omits it.
          set: {
            email,
            displayName: sql`coalesce(excluded.display_name, ${schema.users.displayName})`,
          },
        })
        .returning(SELECTION),
    );
    // An upsert with RETURNING always yields exactly one row; guard satisfies the type + is defensive.
    if (!user) throw new Error('provisioning returned no row');
    return user;
  }

  /** Read the user for a verified identity within their tenant. Undefined if not yet provisioned. */
  async getByAuth(auth: VerifiedAuth): Promise<UserRecord | undefined> {
    const [user] = await withTenant(auth.tenantId, async (tx) =>
      tx
        .select(SELECTION)
        .from(schema.users)
        // RLS already scopes to the tenant; the explicit tenant_id predicate is defense-in-depth.
        .where(
          and(
            eq(schema.users.externalIdentityId, auth.sub),
            eq(schema.users.tenantId, auth.tenantId),
          ),
        )
        .limit(1),
    );
    return user;
  }
}
