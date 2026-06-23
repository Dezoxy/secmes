import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';

import { schema, type Tx } from '../db/index.js';

// Shared conversation authz — the SAME checks the messaging service and the attachment grants run, so there
// is exactly one implementation of "who is this caller" and "are they a member" (no IDOR drift). Both take a
// `Tx` so the check runs in the SAME RLS-scoped transaction as the write it guards.

/**
 * Canonical pair ordering for the friendships table (user_low_id < user_high_id). Lower-casing first
 * ensures uppercase UUID input (valid per ParseUUIDPipe) sorts the same way as the stored lower-case rows.
 */
export function canonicalPair(a: string, b: string): { low: string; high: string } {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? { low: x, high: y } : { low: y, high: x };
}

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
 * (lower-cased, sorted) so the direction of the arguments doesn't matter.
 *
 * Tenant scope is enforced by RLS (FORCE) on the connection — there is deliberately NO explicit
 * `tenant_id` predicate here. The canonical pair is unique only WITHIN a tenant, so this MUST run
 * inside a `withTenant` transaction; calling it on a non-tenant-scoped connection would let a same-id
 * pair from another tenant match.
 */
export async function requireFriendship(tx: Tx, userA: string, userB: string): Promise<void> {
  const { low, high } = canonicalPair(userA, userB);
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

/**
 * Friendship gate for direct (1:1) conversations. If `conversationId` is a DM, the caller must still be
 * an accepted friend of the peer; otherwise this is a no-op (groups are ungated — friendship is a 1:1
 * social-graph concept, and legacy rows where `isDirect IS NULL` are treated as non-DM).
 *
 * Fails CLOSED on anomalies: a DM is asserted to have exactly one peer besides the caller. Zero peers
 * (a DM with no other member) or more than one (an `isDirect` row that somehow accumulated extra members
 * via an invariant violation) both throw 500 rather than gating against an arbitrary member and letting
 * the write through. Callers MUST have run `requireMembership` first (so the conversation is known to
 * exist in this tenant under the active RLS context) and MUST be inside a `withTenant` transaction.
 */
export async function requireDirectFriendship(
  tx: Tx,
  conversationId: string,
  callerUserId: string,
): Promise<void> {
  const [conv] = await tx
    .select({ isDirect: schema.conversations.isDirect })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, conversationId))
    .limit(1);
  // requireMembership (run by every caller) already confirmed existence; a missing row here means the
  // precondition was violated — fail closed rather than silently skip the gate.
  if (!conv) throw new InternalServerErrorException('conversation not found for friendship gate');
  if (conv.isDirect !== true) return;

  const peers = await tx
    .select({ userId: schema.conversationMembers.userId })
    .from(schema.conversationMembers)
    .where(
      and(
        eq(schema.conversationMembers.conversationId, conversationId),
        ne(schema.conversationMembers.userId, callerUserId),
      ),
    )
    .limit(2);
  if (peers.length !== 1) {
    throw new InternalServerErrorException('DM conversation has unexpected membership');
  }
  await requireFriendship(tx, callerUserId, peers[0]!.userId);
}

/**
 * Friendship gate for the moment peers are ADDED to a conversation (deliverWelcome adds one,
 * postCommit may add several via `addedUserIds`) — checked against the EXPLICIT ids being added, not
 * members derived from the table (a peer isn't a member yet at bootstrap). No-op for groups/legacy and
 * for self-adds (a creator pulling in their own other devices reuses the caller id). For a DM every added
 * peer must be an accepted friend of the caller.
 *
 * The whole add set is evaluated AT ONCE: a DM holds exactly two members, so existing members + the
 * distinct NEW peers must not exceed two — otherwise 500 (an invariant breach, never a 403 oracle).
 * Checking per-entry would be unsafe: a single commit adding two new friends would slip past, because each
 * entry on its own sees only the solo creator. Must run inside the SAME `withTenant` transaction as the
 * member-add and BEFORE it, so a rejected add writes no member row.
 */
export async function requireDirectFriendshipForAdd(
  tx: Tx,
  conversationId: string,
  callerUserId: string,
  addedUserIds: readonly string[],
): Promise<void> {
  const [conv] = await tx
    .select({ isDirect: schema.conversations.isDirect })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, conversationId))
    .limit(1);
  if (!conv) throw new InternalServerErrorException('conversation not found for friendship gate');
  if (conv.isDirect !== true) return; // groups + legacy rows are ungated

  // Distinct peers being added — drop self-adds (own other devices reuse the caller id) and duplicates.
  const peers = [...new Set(addedUserIds)].filter((id) => id !== callerUserId);
  if (peers.length === 0) return; // nothing peer-facing to gate (self-only / empty add)

  // DM cardinality across the whole batch: existing members + distinct new peers must not exceed two.
  const existing = await tx
    .select({ userId: schema.conversationMembers.userId })
    .from(schema.conversationMembers)
    .where(eq(schema.conversationMembers.conversationId, conversationId))
    .limit(3);
  const existingIds = new Set(existing.map((m) => m.userId));
  const newPeerCount = peers.filter((id) => !existingIds.has(id)).length;
  if (existingIds.size + newPeerCount > 2) {
    throw new InternalServerErrorException('DM cannot exceed two members');
  }

  for (const peer of peers) {
    await requireFriendship(tx, callerUserId, peer);
  }
}
