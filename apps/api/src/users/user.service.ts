import { BadRequestException, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant } from '../db/index.js';
import { generateHandle } from './handle-words.js';

export interface UserRecord {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
}

const SELECTION = {
  id: schema.users.id,
  email: schema.users.email,
  displayName: schema.users.displayName,
  role: schema.users.role,
} as const;

// With a 40k handle pool a fresh handle almost never collides, but the DB unique index is the source of truth —
// on a 23505 against it we regenerate. The cap stops a pathological/near-full tenant from looping forever (it
// errors loudly instead). See docs/threat-models/pseudonymous-identity.md §6.
const MAX_HANDLE_ATTEMPTS = 8;

// The unique index whose violation means "this generated handle is taken" (see 0016 migration). Matched
// EXACTLY so only a collision on this specific index triggers a regenerate.
const HANDLE_UNIQUE_INDEX = 'users_tenant_display_name_idx';

/**
 * True iff `err` (or any error in its `.cause` chain — Drizzle may wrap the driver error) is a Postgres
 * unique-violation (23505) specifically against the `(tenant_id, display_name)` handle index. Any other 23505
 * (or error) is NOT a handle collision and must propagate, not trigger a retry.
 */
function isHandleCollision(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 5; depth++) {
    if (typeof cur !== 'object') break;
    const o = cur as {
      code?: unknown;
      constraint_name?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (o.code === '23505') {
      const constraint =
        (typeof o.constraint_name === 'string' && o.constraint_name) ||
        (typeof o.constraint === 'string' && o.constraint) ||
        '';
      // Pin to the EXACT handle index — not a `display_name` substring — so a future *display_name* constraint
      // can't silently widen which 23505s trigger a regenerate. (postgres.js sets `constraint_name` to the bare
      // index name; see 0016_users_display_name_unique.sql.)
      if (constraint === HANDLE_UNIQUE_INDEX) return true;
    }
    cur = o.cause;
  }
  return false;
}

@Injectable()
export class UserService {
  /**
   * JIT-provision the user from VERIFIED token claims (idempotent upsert keyed on
   * (tenant_id, external_identity_id)). Runs under the tenant's RLS context, so a token can only ever
   * create/refresh a user in its own tenant. Requires a verified `email` claim.
   *
   * Identity is PSEUDONYMOUS (roadmap #44b): a NEW user is assigned a random "Adjective Animal" handle as their
   * display name — the IdP `name` claim is intentionally NOT used (no real-name leak into the directory; see
   * pseudonymous-identity.md). An EXISTING user keeps their handle (a legacy NULL handle — incl. every legacy
   * name reset to NULL by migration 0016 — is healed to a generated one on next login); `email` is refreshed.
   * Per-tenant uniqueness is DB-enforced (unique (tenant_id, display_name)) with regenerate-on-collision.
   *
   * `generate` is an injection seam so the collision-retry path is deterministically testable; production
   * always uses the CSPRNG-backed default.
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
    for (let attempt = 0; attempt < MAX_HANDLE_ATTEMPTS; attempt++) {
      const displayName = generate();
      try {
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
              // EXISTING user: refresh email; KEEP their handle if they have one (coalesce returns the existing
              // value, the candidate is discarded so it never reaches the display_name index). A NULL
              // display_name (every legacy name was reset to NULL by migration 0016) is HEALED to the candidate
              // handle — which IS then checked against the unique index, so a collision still regenerates.
              set: {
                email,
                displayName: sql`coalesce(${schema.users.displayName}, excluded.display_name)`,
              },
            })
            .returning(SELECTION),
        );
        // An upsert with RETURNING always yields exactly one row; guard satisfies the type + is defensive.
        if (!user) throw new Error('provisioning returned no row');
        return user;
      } catch (err) {
        // A NEW user's generated handle collided with another member's handle — regenerate and retry. Any
        // other error (incl. a non-handle unique violation) propagates immediately.
        if (isHandleCollision(err)) continue;
        throw err;
      }
    }
    throw new Error(
      `could not allocate a unique handle after ${MAX_HANDLE_ATTEMPTS} attempts ` +
        '(tenant handle pool may be exhausted)',
    );
  }

  /** List ACTIVE users in a tenant (the directory), capped by `limit`. RLS scopes it to the tenant. */
  async list(tenantId: string, limit: number): Promise<UserRecord[]> {
    return withTenant(tenantId, async (tx) =>
      tx
        .select(SELECTION)
        .from(schema.users)
        .where(eq(schema.users.status, 'active')) // don't surface deactivated/suspended members
        .orderBy(schema.users.email)
        .limit(limit),
    );
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
