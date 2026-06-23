import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { schema, type Tx } from '../db/index.js';

// Shared conversation authz — the SAME checks the messaging service and the attachment grants run, so there
// is exactly one implementation of "who is this caller" and "are they a member" (no IDOR drift). Both take a
// `Tx` so the check runs in the SAME RLS-scoped transaction as the write it guards.

/**
 * Resolve the VERIFIED caller to an ACTIVE tenant user id. Never trusts a client-supplied id, and
 * only resolves an active user — a soft-deleted/suspended member with a still-valid bearer token can't act.
 *
 * Accepts either a full auth object (preferred — handles both argus and Zitadel tokens) or a plain
 * sub string for call sites that only have the sub available.
 */
export async function requireUser(
  tx: Tx,
  auth: { sub: string; userId?: string } | string,
): Promise<string> {
  const resolved = typeof auth === 'string' ? { sub: auth, userId: undefined } : auth;
  const userCondition = resolved.userId
    ? eq(schema.users.id, resolved.userId)
    : eq(schema.users.externalIdentityId, resolved.sub);
  const [user] = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(userCondition, eq(schema.users.status, 'active')))
    .limit(1);
  if (!user) throw new BadRequestException('user not provisioned or not active');
  return user.id;
}

/**
 * Throw 404 unless `userId` is a member of `conversationId`. The SAME 404 covers a non-member and a
 * non-existent / RLS-hidden (wrong-tenant) conversation, so the API never reveals which conversations exist
 * to a non-member. This is the intra-tenant authz the schema/RLS deferred to the app layer.
 */
export async function requireMembership(
  tx: Tx,
  conversationId: string,
  userId: string,
): Promise<void> {
  const [member] = await tx
    .select({ id: schema.conversationMembers.id })
    .from(schema.conversationMembers)
    .where(
      and(
        eq(schema.conversationMembers.conversationId, conversationId),
        eq(schema.conversationMembers.userId, userId),
      ),
    )
    .limit(1);
  if (!member) throw new NotFoundException('conversation not found');
}

/**
 * Throw 403 unless `userA` and `userB` have an accepted friendship row. Looks up the canonical pair
 * (lower-cased, sorted) so the direction of the arguments doesn't matter. Must run inside a
 * `withTenant` transaction so the RLS tenant context is already set on the connection.
 */
export async function requireFriendship(tx: Tx, userA: string, userB: string): Promise<void> {
  const a = userA.toLowerCase();
  const b = userB.toLowerCase();
  const [low, high] = a < b ? [a, b] : [b, a];
  const [row] = await tx
    .select({ id: schema.friendships.id })
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.userLowId, low),
        eq(schema.friendships.userHighId, high),
        eq(schema.friendships.status, 'accepted'),
      ),
    )
    .limit(1);
  if (!row) throw new ForbiddenException('friendship required');
}
