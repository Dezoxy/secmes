import { Injectable, NotFoundException } from '@nestjs/common';
import type { Friend, FriendRequest, FriendRequestBox } from '@argus/contracts';
import { and, eq, gt, lt, ne, or, sql } from 'drizzle-orm';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant } from '../db/index.js';
import { canonicalPair, requireUser } from '../messaging/membership.js';
import { PushService } from '../push/push.service.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';
import { UserService } from '../users/user.service.js';

/** Pending friend requests live this long before the argus_cleanup sweep reaps them (R-friends-2). */
const FRIEND_REQUEST_TTL_DAYS = 14;

/** SQL expression for "the OTHER party in this row, relative to `me`". */
function otherParty(me: string) {
  return sql<string>`case when ${schema.friendships.userLowId} = ${me} then ${schema.friendships.userHighId} else ${schema.friendships.userLowId} end`;
}

@Injectable()
export class FriendsService {
  constructor(
    private readonly users: UserService,
    private readonly bus: RealtimeBus,
    private readonly push: PushService,
  ) {}

  /**
   * Create a friend request addressed by exact argus-id. Returns whether the target was found (for the
   * caller's audit trail only) — the HTTP layer responds with a uniform 202 regardless of outcome, so
   * not-found / inactive / self / already-friends / already-pending are indistinguishable to the client
   * (no enumeration oracle; R-friends-3). A re-request or an existing/reciprocal pair is a no-op via the
   * canonical-pair unique constraint (ON CONFLICT DO NOTHING).
   */
  async sendRequest(auth: VerifiedAuth, argusId: string): Promise<{ targetFound: boolean }> {
    // Resolve the CALLER first. A revoked/soft-deleted caller still holding an unexpired token is
    // rejected here (400) BEFORE any target-dependent branch — otherwise the not-found path (202) and
    // the active-target path (which would 400 only later) differ, turning this into an active-user
    // existence oracle for offboarded tokens. After this gate, the response depends only on the
    // caller's own status, never on whether the target exists.
    const me = await withTenant(auth.tenantId, (tx) => requireUser(tx, auth));

    const target = await this.users.lookupByArgusId(auth.tenantId, argusId);
    if (!target) return { targetFound: false };
    // Reject self silently — uniform 202, no row.
    if (target.userId === me) return { targetFound: true };

    const { low, high } = canonicalPair(me, target.userId);
    const expiresAt = new Date(Date.now() + FRIEND_REQUEST_TTL_DAYS * 24 * 60 * 60 * 1000);
    const { rowWritten, recipientSubs, recipientUserId } = await withTenant(
      auth.tenantId,
      async (tx) => {
        const [row] = await tx
          .insert(schema.friendships)
          .values({
            tenantId: auth.tenantId,
            userLowId: low,
            userHighId: high,
            status: 'pending',
            requestedBy: me,
            expiresAt,
          })
          // One row per canonical pair. On conflict, REVIVE the row only if the existing one is an
          // EXPIRED pending request (resetting requester + expiry from this caller). A live pending row
          // or an accepted friendship is left untouched (setWhere matches nothing → no-op). Without this,
          // an expired-but-unswept row would deadlock the pair: every re-request would silently no-op
          // against it while the API treats it as inert, until the cleanup sweep finally deletes it.
          .onConflictDoUpdate({
            target: [
              schema.friendships.tenantId,
              schema.friendships.userLowId,
              schema.friendships.userHighId,
            ],
            set: { status: 'pending', requestedBy: me, expiresAt, resolvedAt: null },
            setWhere: and(
              eq(schema.friendships.status, 'pending'),
              lt(schema.friendships.expiresAt, new Date()),
            ),
          })
          .returning({ id: schema.friendships.id });

        // No row returned ⇒ conflict with a live-pending or accepted row — notify would be spurious.
        if (!row)
          return { rowWritten: false, recipientSubs: [] as string[], recipientUserId: null };

        // Resolve the recipient's subs in the same tx while RLS context is active.
        const [recipient] = await tx
          .select({
            id: schema.users.id,
            externalSub: schema.users.externalIdentityId,
            argusId: schema.users.argusId,
          })
          .from(schema.users)
          .where(and(eq(schema.users.tenantId, auth.tenantId), eq(schema.users.id, target.userId)))
          .limit(1);

        return {
          rowWritten: true,
          // Both sub families so sockets authenticated under either token family receive the nudge.
          // Dedup in case externalSub already carries the argusid: prefix (defensive).
          recipientSubs: recipient
            ? [...new Set([recipient.externalSub, `argusid:${recipient.argusId}`])]
            : ([] as string[]),
          recipientUserId: recipient?.id ?? null,
        };
      },
    );

    // Best-effort notify — fired after the tx commits so the DB row is durable first.
    // Neither failure changes the uniform 202 (R-friends-3).
    if (rowWritten) {
      for (const recipientSub of recipientSubs) {
        this.bus.emitFriendRequestCreated({ tenantId: auth.tenantId, recipientSub });
      }
      if (recipientUserId) {
        void this.push.notifyUser(auth.tenantId, recipientUserId, 'friend_request').catch(() => {});
      }
    }

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
            // Enforce the TTL at the API layer too — an expired request is invisible/inert even if the
            // argus_cleanup sweep has not run yet (no scheduler is wired until a later slice).
            gt(schema.friendships.expiresAt, new Date()),
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
   * matches 0 rows → uniform 404, never another user's row (R-friends-5 / IDOR gate). The requester must
   * ALSO still be an active user — accepting an offboarded requester would mint a live friendship to a
   * dead account (the requester is the `requested_by` party; an inactive one yields 0 rows → 404).
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
        .where(
          and(
            this.recipientPredicate(requestId, me, auth.tenantId),
            // The requester must still be active (RLS already scopes `users` to this tenant).
            sql`exists (select 1 from users where users.id = ${schema.friendships.requestedBy} and users.status = 'active')`,
          ),
        )
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
            // Expired requests are inert at the API layer even before the sweep runs.
            gt(schema.friendships.expiresAt, new Date()),
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
      // Expired requests are inert at the API layer even before the sweep runs.
      gt(schema.friendships.expiresAt, new Date()),
      or(eq(schema.friendships.userLowId, me), eq(schema.friendships.userHighId, me)),
      ne(schema.friendships.requestedBy, me),
    );
  }
}
