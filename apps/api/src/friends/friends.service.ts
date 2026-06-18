import { Injectable, NotFoundException } from '@nestjs/common';
import type { Friend, FriendRequest, FriendRequestBox } from '@argus/contracts';
import { and, eq, ne, or, sql } from 'drizzle-orm';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant } from '../db/index.js';
import { requireUser } from '../messaging/membership.js';
import { UserService } from '../users/user.service.js';

/** Pending friend requests live this long before the argus_cleanup sweep reaps them (R-friends-2). */
const FRIEND_REQUEST_TTL_DAYS = 14;

/**
 * Canonical pair ordering: the friendships table stores ONE row per unordered pair, keyed by
 * (user_low_id < user_high_id). Sorting the two ids here matches the DB's `friendships_canonical_order`
 * CHECK so both directions collapse to the same row (no bidirectional-duplicate bug).
 */
function canonicalPair(a: string, b: string): { low: string; high: string } {
  return a < b ? { low: a, high: b } : { low: b, high: a };
}

/** SQL expression for "the OTHER party in this row, relative to `me`". */
function otherParty(me: string) {
  return sql<string>`case when ${schema.friendships.userLowId} = ${me} then ${schema.friendships.userHighId} else ${schema.friendships.userLowId} end`;
}

@Injectable()
export class FriendsService {
  constructor(private readonly users: UserService) {}

  /**
   * Create a friend request addressed by exact argus-id. Returns whether the target was found (for the
   * caller's audit trail only) — the HTTP layer responds with a uniform 202 regardless of outcome, so
   * not-found / inactive / self / already-friends / already-pending are indistinguishable to the client
   * (no enumeration oracle; R-friends-3). A re-request or an existing/reciprocal pair is a no-op via the
   * canonical-pair unique constraint (ON CONFLICT DO NOTHING).
   */
  async sendRequest(auth: VerifiedAuth, argusId: string): Promise<{ targetFound: boolean }> {
    const target = await this.users.lookupByArgusId(auth.tenantId, argusId);
    if (!target) return { targetFound: false };

    await withTenant(auth.tenantId, async (tx) => {
      const me = await requireUser(tx, auth);
      // Reject self silently — uniform 202, no row.
      if (target.userId === me) return;
      const { low, high } = canonicalPair(me, target.userId);
      await tx
        .insert(schema.friendships)
        .values({
          tenantId: auth.tenantId,
          userLowId: low,
          userHighId: high,
          status: 'pending',
          requestedBy: me,
          expiresAt: new Date(Date.now() + FRIEND_REQUEST_TTL_DAYS * 24 * 60 * 60 * 1000),
        })
        // One row per canonical pair: any existing pending/accepted row makes this a no-op.
        .onConflictDoNothing({
          target: [
            schema.friendships.tenantId,
            schema.friendships.userLowId,
            schema.friendships.userHighId,
          ],
        });
    });
    return { targetFound: true };
  }

  /** Accepted friends for the caller — the durable contact-recovery source. */
  async listFriends(auth: VerifiedAuth): Promise<Friend[]> {
    return withTenant(auth.tenantId, async (tx) => {
      const me = await requireUser(tx, auth);
      const rows = await tx
        .select({
          userId: schema.users.id,
          argusId: schema.users.argusId,
          displayName: schema.users.displayName,
          avatarSeed: schema.users.avatarSeed,
          since: schema.friendships.resolvedAt,
        })
        .from(schema.friendships)
        // Join the OTHER party's profile in one query (no N+1).
        .innerJoin(schema.users, eq(schema.users.id, otherParty(me)))
        .where(
          and(
            eq(schema.friendships.tenantId, auth.tenantId),
            eq(schema.friendships.status, 'accepted'),
            or(eq(schema.friendships.userLowId, me), eq(schema.friendships.userHighId, me)),
          ),
        );
      return rows.map((r) => ({
        userId: r.userId,
        argusId: r.argusId,
        displayName: r.displayName,
        avatarSeed: r.avatarSeed,
        // resolved_at is non-null for accepted rows (set on accept); fall back to epoch defensively.
        since: (r.since ?? new Date(0)).toISOString(),
      }));
    });
  }

  /** Open (pending) requests in the requested mailbox. Direction derives from `requested_by`. */
  async listRequests(auth: VerifiedAuth, box: FriendRequestBox): Promise<FriendRequest[]> {
    return withTenant(auth.tenantId, async (tx) => {
      const me = await requireUser(tx, auth);
      // incoming = someone else opened it (requested_by ≠ me); outgoing = I opened it.
      const directionPredicate =
        box === 'incoming'
          ? ne(schema.friendships.requestedBy, me)
          : eq(schema.friendships.requestedBy, me);
      const rows = await tx
        .select({
          requestId: schema.friendships.id,
          userId: schema.users.id,
          argusId: schema.users.argusId,
          displayName: schema.users.displayName,
          avatarSeed: schema.users.avatarSeed,
          createdAt: schema.friendships.createdAt,
        })
        .from(schema.friendships)
        .innerJoin(schema.users, eq(schema.users.id, otherParty(me)))
        .where(
          and(
            eq(schema.friendships.tenantId, auth.tenantId),
            eq(schema.friendships.status, 'pending'),
            or(eq(schema.friendships.userLowId, me), eq(schema.friendships.userHighId, me)),
            directionPredicate,
          ),
        );
      return rows.map((r) => ({
        requestId: r.requestId,
        userId: r.userId,
        argusId: r.argusId,
        displayName: r.displayName,
        avatarSeed: r.avatarSeed,
        direction: box,
        createdAt: r.createdAt.toISOString(),
      }));
    });
  }

  /**
   * Accept a pending request — RECIPIENT-ONLY. The authz lives entirely in the WHERE clause: the caller
   * must be a member of the pair AND must NOT be the requester. A non-recipient (or wrong-id) caller
   * matches 0 rows → uniform 404, never another user's row (R-friends-5 / IDOR gate).
   */
  async accept(auth: VerifiedAuth, requestId: string): Promise<void> {
    const updated = await withTenant(auth.tenantId, async (tx) => {
      const me = await requireUser(tx, auth);
      return tx
        .update(schema.friendships)
        .set({
          status: 'accepted',
          resolvedAt: new Date(),
          // Clear the transient request intent — satisfies friendships_accepted_must_clear_expiry.
          requestedBy: null,
          expiresAt: null,
        })
        .where(this.recipientPredicate(requestId, me, auth.tenantId))
        .returning({ id: schema.friendships.id });
    });
    if (updated.length === 0) throw new NotFoundException();
  }

  /** Decline a pending request — RECIPIENT-ONLY; hard DELETE (no rejection ledger). */
  async decline(auth: VerifiedAuth, requestId: string): Promise<void> {
    const deleted = await withTenant(auth.tenantId, async (tx) => {
      const me = await requireUser(tx, auth);
      return tx
        .delete(schema.friendships)
        .where(this.recipientPredicate(requestId, me, auth.tenantId))
        .returning({ id: schema.friendships.id });
    });
    if (deleted.length === 0) throw new NotFoundException();
  }

  /** Cancel a pending request — REQUESTER-ONLY; hard DELETE. */
  async cancel(auth: VerifiedAuth, requestId: string): Promise<void> {
    const deleted = await withTenant(auth.tenantId, async (tx) => {
      const me = await requireUser(tx, auth);
      return tx
        .delete(schema.friendships)
        .where(
          and(
            eq(schema.friendships.id, requestId),
            eq(schema.friendships.tenantId, auth.tenantId),
            eq(schema.friendships.status, 'pending'),
            // requester-only: requested_by is the canonical opener; it is always a party (DB CHECK).
            eq(schema.friendships.requestedBy, me),
          ),
        )
        .returning({ id: schema.friendships.id });
    });
    if (deleted.length === 0) throw new NotFoundException();
  }

  /** Unfriend an accepted friend — MEMBER-ONLY; hard DELETE. Addressed by the friend's userId. */
  async unfriend(auth: VerifiedAuth, friendUserId: string): Promise<void> {
    const deleted = await withTenant(auth.tenantId, async (tx) => {
      const me = await requireUser(tx, auth);
      const { low, high } = canonicalPair(me, friendUserId);
      return tx
        .delete(schema.friendships)
        .where(
          and(
            eq(schema.friendships.tenantId, auth.tenantId),
            eq(schema.friendships.status, 'accepted'),
            eq(schema.friendships.userLowId, low),
            eq(schema.friendships.userHighId, high),
            // Defense-in-depth: the canonical pair built from `me` always contains me; assert it.
            or(eq(schema.friendships.userLowId, me), eq(schema.friendships.userHighId, me)),
          ),
        )
        .returning({ id: schema.friendships.id });
    });
    if (deleted.length === 0) throw new NotFoundException();
  }

  /**
   * Shared recipient-only predicate for accept/decline: row id matches, still pending, caller is a
   * member of the pair, and caller is NOT the requester (so they are the addressee). Since requested_by
   * is guaranteed to be one of the two parties (DB CHECK), "member AND not requester" == "recipient".
   */
  private recipientPredicate(requestId: string, me: string, tenantId: string) {
    return and(
      eq(schema.friendships.id, requestId),
      eq(schema.friendships.tenantId, tenantId),
      eq(schema.friendships.status, 'pending'),
      or(eq(schema.friendships.userLowId, me), eq(schema.friendships.userHighId, me)),
      ne(schema.friendships.requestedBy, me),
    );
  }
}
