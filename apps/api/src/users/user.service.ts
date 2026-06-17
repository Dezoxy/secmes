import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { UpdateProfile, UserLookupResult } from '@argus/contracts';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant } from '../db/index.js';
import { generateArgusId, isArgusIdCollision } from './argus-id.js';
import { generateHandle } from './handle-words.js';

export interface UserRecord {
  id: string;
  argusId: string;
  displayName: string | null;
  avatarSeed: string | null;
  role: string;
}

export interface DirectoryRecord {
  id: string;
  email: string | null;
  displayName: string | null;
  role: string;
}

// Full identity projection for /me (getByAuth + provisionFromToken). email is included
// so provisionFromToken can write it; it is NOT in UserRecord (not exposed to controllers).
const ME_SELECTION = {
  id: schema.users.id,
  argusId: schema.users.argusId,
  email: schema.users.email,
  displayName: schema.users.displayName,
  avatarSeed: schema.users.avatarSeed,
  role: schema.users.role,
} as const;

// Directory projection — argusId intentionally excluded; used by list() → GET /users.
// argusId is a user's persistent pseudonymous identity and must not be exposed to all tenant members.
const DIRECTORY_SELECTION = {
  id: schema.users.id,
  email: schema.users.email,
  displayName: schema.users.displayName,
  role: schema.users.role,
} as const;

@Injectable()
export class UserService {
  /**
   * JIT-provision the user from VERIFIED token claims (idempotent upsert keyed on
   * (tenant_id, external_identity_id)). Runs under the tenant's RLS context.
   *
   * Display names are free nicknames (unique index dropped in 0038) — no retry loop needed.
   * A short retry loop is kept only for the (vanishingly rare) argus_id collision.
   */
  async provisionFromToken(
    auth: VerifiedAuth,
    generate: () => string = generateHandle,
  ): Promise<UserRecord> {
    if (!auth.email) {
      throw new BadRequestException(
        'token is missing the email claim required to provision a user',
      );
    }
    const email = auth.email;
    for (let attempt = 0; attempt < 3; attempt++) {
      const displayName = generate();
      const argusId = generateArgusId();
      try {
        const [user] = await withTenant(auth.tenantId, async (tx) =>
          tx
            .insert(schema.users)
            .values({
              tenantId: auth.tenantId,
              externalIdentityId: auth.sub,
              email,
              displayName,
              argusId,
            })
            .onConflictDoUpdate({
              target: [schema.users.tenantId, schema.users.externalIdentityId],
              // EXISTING user: refresh email; KEEP their display name if they have one (coalesce returns the
              // existing value). A NULL display_name is healed to the candidate on next login.
              // argusId is intentionally excluded from SET — immutability is DB-enforced via trigger.
              set: {
                email,
                displayName: sql`coalesce(${schema.users.displayName}, excluded.display_name)`,
              },
            })
            .returning(ME_SELECTION),
        );
        if (!user) throw new Error('provisioning returned no row');
        return {
          id: user.id,
          argusId: user.argusId,
          displayName: user.displayName,
          avatarSeed: user.avatarSeed,
          role: user.role,
        };
      } catch (err) {
        if (isArgusIdCollision(err)) continue;
        throw err;
      }
    }
    throw new Error('could not allocate a unique argus-id after 3 attempts');
  }

  /** List ACTIVE users in a tenant (the directory), capped by `limit`. RLS scopes it to the tenant. */
  async list(tenantId: string, limit: number): Promise<DirectoryRecord[]> {
    return withTenant(tenantId, async (tx) =>
      tx
        .select(DIRECTORY_SELECTION)
        .from(schema.users)
        .where(
          and(
            eq(schema.users.status, 'active'),
            or(isNull(schema.users.displayName), ne(schema.users.displayName, 'breakglass-admin')),
          ),
        )
        .orderBy(schema.users.email)
        .limit(limit),
    );
  }

  /** Read the user for a verified identity within their tenant. Undefined if not yet provisioned. */
  async getByAuth(auth: VerifiedAuth): Promise<UserRecord | undefined> {
    const [user] = await withTenant(auth.tenantId, async (tx) =>
      tx
        .select(ME_SELECTION)
        .from(schema.users)
        // RLS already scopes to the tenant; the explicit tenant_id predicate is defense-in-depth.
        .where(
          and(
            auth.userId
              ? eq(schema.users.id, auth.userId)
              : eq(schema.users.externalIdentityId, auth.sub),
            eq(schema.users.tenantId, auth.tenantId),
            eq(schema.users.status, 'active'),
          ),
        )
        .limit(1),
    );
    if (!user) return undefined;
    return {
      id: user.id,
      argusId: user.argusId,
      displayName: user.displayName,
      avatarSeed: user.avatarSeed,
      role: user.role,
    };
  }

  /**
   * Exact-match lookup by argus-id. Returns null for both "not found" and "found but inactive"
   * (uniform not-found — no oracle for inactive/suspended users; see discovery-by-argus-id.md).
   */
  async lookupByArgusId(tenantId: string, argusId: string): Promise<UserLookupResult | null> {
    const [row] = await withTenant(tenantId, async (tx) =>
      tx
        .select({
          userId: schema.users.id,
          argusId: schema.users.argusId,
          displayName: schema.users.displayName,
          avatarSeed: schema.users.avatarSeed,
        })
        .from(schema.users)
        .where(
          and(
            eq(schema.users.tenantId, tenantId),
            eq(schema.users.argusId, argusId),
            eq(schema.users.status, 'active'),
          ),
        )
        .limit(1),
    );
    return row ?? null;
  }

  /**
   * Update the caller's own display name and/or avatar seed. Only provided fields are updated.
   * argusId is not in the schema — immutability is enforced by Zod (unknown fields stripped) and
   * the `users_argus_id_immutable` DB trigger.
   */
  async updateProfile(
    auth: { tenantId: string; userId: string },
    dto: UpdateProfile,
  ): Promise<void> {
    if (!dto.displayName && !dto.avatarSeed) return;
    const set: Partial<typeof schema.users.$inferInsert> = {};
    if (dto.displayName !== undefined) set.displayName = dto.displayName;
    if (dto.avatarSeed !== undefined) set.avatarSeed = dto.avatarSeed;
    const result = await withTenant(auth.tenantId, async (tx) =>
      tx
        .update(schema.users)
        .set(set)
        .where(and(eq(schema.users.id, auth.userId), eq(schema.users.tenantId, auth.tenantId)))
        .returning({ id: schema.users.id }),
    );
    if (result.length === 0) throw new NotFoundException('user not found');
  }
}
