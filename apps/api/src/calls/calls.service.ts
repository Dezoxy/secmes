import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { mintTurnCredential } from '@argus/crypto';
import { randomUUID } from 'node:crypto';
import { and, count, eq, or } from 'drizzle-orm';

import type {
  CallSettingsResponse,
  CreateCallRequest,
  CreateCallResponse,
  TurnCredentialsResponse,
  UpdateCallSettingsRequest,
} from './calls.schemas.js';
import { TURN_SHARED_SECRET } from './calls.config.js';
import { CallsAuthzService } from './calls-authz.service.js';
import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant } from '../db/index.js';
import { canonicalPair, requireUser } from '../messaging/membership.js';
import { MessagingService } from '../messaging/messaging.service.js';
import { RealtimeBus } from '../realtime/realtime-bus.js';

/** TURN credential TTL: 600 s (10 min). Short enough that a leaked credential is near-useless;
 *  long enough to set up and complete a relay-only audio call. Clients re-fetch per call attempt. */
const TURN_TTL_SECONDS = 600;

/** TURN server URIs. Non-secret config delivered via TURN_SERVER_HOST env (defaults to local dev). */
function turnUrls(): string[] {
  const host = process.env['TURN_SERVER_HOST'] ?? 'turn.4rgus.com';
  return [`turn:${host}:3478`, `turns:${host}:5349?transport=tcp`];
}

@Injectable()
export class CallsService {
  constructor(
    @Inject(TURN_SHARED_SECRET) private readonly hmacKey: string,
    private readonly callsAuthz: CallsAuthzService,
    private readonly messaging: MessagingService,
    private readonly bus: RealtimeBus,
  ) {}

  /**
   * Mint ephemeral TURN credentials for a requester who has ≥1 accepted friend (coarse gate).
   * The gate is requester-only and per-pair-blind: it reflects only the caller's own friend-count,
   * never whether they are friends with a specific callee (docs/planning/voip/04 §2.2, D6/Q7-A).
   *
   * HMAC-SHA1 credential follows the TURN REST API convention coturn implements via use-auth-secret:
   *   username  = "<expiry-unix-ts>:<users.id>"
   *   credential = base64( HMAC-SHA1( username, static-auth-secret ) )
   *
   * The credential is SECRET-EQUIVALENT — never passed to any logger, never returned in errors.
   */
  async mintTurnCredentials(auth: VerifiedAuth): Promise<TurnCredentialsResponse> {
    const userId = await withTenant(auth.tenantId, async (tx) => {
      // requireUser returns users.id (string) directly — throws 404 if the user row is gone.
      const id = await requireUser(tx, auth);

      // Coarse friendship gate: ≥1 accepted friend required (D6/Q7-A).
      // RLS is active inside withTenant — the count is tenant-scoped without an explicit tenant filter.
      const [row] = await tx
        .select({ n: count() })
        .from(schema.friendships)
        .where(
          and(
            eq(schema.friendships.status, 'accepted'),
            or(eq(schema.friendships.userLowId, id), eq(schema.friendships.userHighId, id)),
          ),
        )
        .limit(1);

      if (!row || row.n === 0) {
        throw new ForbiddenException(
          'no accepted friends — TURN credentials require ≥1 accepted friend',
        );
      }

      return id;
    });

    // Bucket expiry to the start of the current TTL window + 2×TTL.
    // All requests within the same 600s window share the same `expiry:userId` username so
    // coturn's user-quota=6 correctly counts simultaneous relay allocations per user
    // rather than per ever-changing credential string. Valid for 600–1200 s.
    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / TURN_TTL_SECONDS) * TURN_TTL_SECONDS;
    const expiry = windowStart + 2 * TURN_TTL_SECONDS;
    const username = `${expiry}:${userId}`;
    const credential = await mintTurnCredential(username, this.hmacKey);

    return {
      iceServers: [{ urls: turnUrls(), username, credential }],
      iceTransportPolicy: 'relay', // V1: always relay — preference stored but ignored until V1.1 (voip plan §04)
      ttlSeconds: expiry - now,
    };
  }

  /**
   * Initiate a 1:1 audio call. Gates: accepted friendship + conversation membership.
   *
   * Returns a uniform 202 + `{ callId }` regardless of gate outcome — the caller cannot tell whether
   * the callee exists, is a friend, or is in the conversation (no presence/friendship oracle). A
   * callId is always minted; it is only registered in the authz map when gates pass, so the callee
   * can only be ringed if the caller is a legitimate participant.
   */
  async invite(
    auth: VerifiedAuth,
    friendUserId: string,
    body: CreateCallRequest,
  ): Promise<CreateCallResponse> {
    const callId = randomUUID();

    const result = await withTenant(auth.tenantId, async (tx) => {
      const myId = await requireUser(tx, auth);

      // Accepted-friendship gate: canonicalPair lowercases both UUIDs before sorting so an
      // uppercase path param (accepted by ParseUUIDPipe) maps to the same stored row.
      const { low, high } = canonicalPair(myId, friendUserId);
      const [friendship] = await tx
        .select({
          calleeExternalId: schema.users.externalIdentityId,
          calleeArgusId: schema.users.argusId,
        })
        .from(schema.friendships)
        .innerJoin(schema.users, eq(schema.users.id, friendUserId))
        .where(
          and(
            eq(schema.friendships.userLowId, low),
            eq(schema.friendships.userHighId, high),
            eq(schema.friendships.status, 'accepted'),
          ),
        )
        .limit(1);

      // Callee membership + direct-conversation gate. Both checks run inside the tx so RLS is
      // active. `isDirect` guards against group-conversation callIds leaking call timing to
      // non-participant room members via the server-issued call.end fan-out.
      let calleeIsConvMember = false;
      let isDirectConversation = false;
      if (friendship) {
        const [calleeMember] = await tx
          .select({ userId: schema.conversationMembers.userId })
          .from(schema.conversationMembers)
          .where(
            and(
              eq(schema.conversationMembers.conversationId, body.conversationId),
              eq(schema.conversationMembers.userId, friendUserId),
            ),
          )
          .limit(1);
        calleeIsConvMember = calleeMember !== undefined;

        if (calleeIsConvMember) {
          const [conv] = await tx
            .select({ isDirect: schema.conversations.isDirect })
            .from(schema.conversations)
            .where(eq(schema.conversations.id, body.conversationId))
            .limit(1);
          isDirectConversation = conv?.isDirect === true;
        }
      }

      // Both sub families for the callee — same pattern as friends.service / message-delivery so
      // sockets authenticated under either token family (legacy externalId vs argusid:) receive the ring.
      const calleeSubs = friendship
        ? [...new Set([friendship.calleeExternalId, `argusid:${friendship.calleeArgusId}`])]
        : null;
      return {
        calleeSubs,
        calleeArgusId: friendship?.calleeArgusId ?? null,
        calleeIsConvMember,
        isDirectConversation,
        callerUserId: myId,
      };
    });

    if (!result.calleeSubs) return { callId }; // no friendship — uniform return, no oracle
    if (!result.calleeIsConvMember) return { callId }; // callee not in conversation — uniform return, no oracle
    if (!result.isDirectConversation) return { callId }; // group conversation — V1 requires a 1:1 DM

    // Caller membership check — out of tx (read-only, RLS-scoped via the service layer).
    const isMember = await this.messaging.isMember(auth, body.conversationId);
    if (!isMember) return { callId }; // no membership — uniform return, no oracle

    // Both gates passed: register the call and ring the callee.
    // Store the canonical argusid: form as calleeSub in the authz map — all passkey-authed sockets
    // present this subject. Ring events are emitted for both sub families so legacy-externalId sockets
    // also receive the ring (belt + suspenders; Set deduplication avoids double-ring for new users).
    const canonicalCalleeSub = `argusid:${result.calleeArgusId}`;
    this.callsAuthz.register(callId, {
      tenantId: auth.tenantId,
      conversationId: body.conversationId,
      callerSub: auth.sub,
      calleeSub: canonicalCalleeSub,
    });
    for (const calleeSub of result.calleeSubs) {
      this.bus.emitCallRing({
        tenantId: auth.tenantId,
        callId,
        conversationId: body.conversationId,
        callerUserId: result.callerUserId,
        calleeSub,
        media: body.media,
      });
    }

    return { callId };
  }

  /** Return the caller's relay-only preference. */
  async getSettings(auth: VerifiedAuth): Promise<CallSettingsResponse> {
    return withTenant(auth.tenantId, async (tx) => {
      const [row] = await tx
        .select({ relayOnly: schema.users.callRelayOnly })
        .from(schema.users)
        .where(eq(schema.users.id, auth.userId ?? ''))
        .limit(1);
      return { relayOnly: row?.relayOnly ?? true };
    });
  }

  /** Persist the caller's relay-only preference and return the updated value. */
  async updateSettings(
    auth: VerifiedAuth,
    body: UpdateCallSettingsRequest,
  ): Promise<CallSettingsResponse> {
    return withTenant(auth.tenantId, async (tx) => {
      const myId = await requireUser(tx, auth);
      await tx
        .update(schema.users)
        .set({ callRelayOnly: body.relayOnly })
        .where(eq(schema.users.id, myId));
      return { relayOnly: body.relayOnly };
    });
  }
}
