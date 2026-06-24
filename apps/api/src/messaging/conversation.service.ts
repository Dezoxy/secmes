import { BadRequestException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant } from '../db/index.js';
import { requireFriendship, requireMembership, requireUser } from './membership.js';
import type { CreatedConversation } from './messaging.types.js';

// Conversation lifecycle + membership reads. One of four internal collaborators the MessagingService
// façade composes (see messaging.service.ts); constructed by the façade, not a DI provider.
export class ConversationService {
  /** Is the verified caller a member of `conversationId`? Used by the realtime gateway's subscribe authz. */
  async isMember(auth: VerifiedAuth, conversationId: string): Promise<boolean> {
    return withTenant(auth.tenantId, async (tx) => {
      const user = await requireUser(tx, auth);
      const [member] = await tx
        .select({ id: schema.conversationMembers.id })
        .from(schema.conversationMembers)
        .where(
          and(
            eq(schema.conversationMembers.conversationId, conversationId),
            eq(schema.conversationMembers.userId, user),
          ),
        )
        .limit(1);
      return !!member;
    });
  }

  /**
   * Create a conversation owned by the caller; add the caller + `memberUserIds` as members. Member ids
   * must be users IN THE CALLER'S TENANT — the composite FK `(tenant_id, user_id) → users(tenant_id, id)`
   * rejects a non-existent or cross-tenant id (surfaced as 400). No message content is involved.
   */
  async createConversation(
    auth: VerifiedAuth,
    memberUserIds: string[],
    isDirect: boolean,
  ): Promise<CreatedConversation> {
    if (isDirect && memberUserIds.length !== 1) {
      throw new BadRequestException('direct conversation requires exactly one peer');
    }
    return withTenant(auth.tenantId, async (tx) => {
      const creator = await requireUser(tx, auth);

      // Friendship gate for a DM created with the peer directly in the body. The real client creates a DM
      // as a SOLO conversation (memberUserIds is the creator's own id) and adds the peer later via
      // deliverWelcome / postCommit — that solo case skips this check (memberUserIds[0] === creator) and is
      // gated at those add sites. But a modified/stale client may pass the real peer here, inserting it as a
      // member directly; gate that path so a non-friend DM can't be established this way either.
      if (isDirect && memberUserIds[0] !== creator) {
        await requireFriendship(tx, creator, memberUserIds[0]!);
      }

      const [conv] = await tx
        .insert(schema.conversations)
        .values({
          tenantId: auth.tenantId,
          createdBy: creator,
          isDirect,
        })
        .returning({ id: schema.conversations.id });
      if (!conv) throw new Error('conversation insert returned no row');

      const members = [...new Set([creator, ...memberUserIds])]; // creator always in; dedup
      try {
        await tx
          .insert(schema.conversationMembers)
          .values(
            members.map((userId) => ({ tenantId: auth.tenantId, conversationId: conv.id, userId })),
          );
      } catch {
        // Composite FK to users(tenant_id, id) rejects an unknown / other-tenant member id. Rolls back
        // the conversation insert too (same tx). Don't echo the ids — just reject the request.
        throw new BadRequestException('one or more member user ids are invalid for this tenant');
      }
      return { conversationId: conv.id };
    });
  }

  /** List identity metadata for all members of a conversation.
   * AUTHZ: caller must be a member (requireMembership throws 404 for non-members). */
  async getConversationMembers(
    auth: VerifiedAuth,
    conversationId: string,
  ): Promise<
    Array<{
      userId: string;
      argusId: string;
      displayName: string | null;
      avatarSeed: string | null;
    }>
  > {
    return withTenant(auth.tenantId, async (tx) => {
      const callerId = await requireUser(tx, auth);
      await requireMembership(tx, conversationId, callerId);
      return tx
        .select({
          userId: schema.users.id,
          argusId: schema.users.argusId,
          displayName: schema.users.displayName,
          avatarSeed: schema.users.avatarSeed,
        })
        .from(schema.conversationMembers)
        .innerJoin(
          schema.users,
          and(
            eq(schema.conversationMembers.userId, schema.users.id),
            eq(schema.conversationMembers.tenantId, schema.users.tenantId),
          ),
        )
        .where(eq(schema.conversationMembers.conversationId, conversationId));
    });
  }
}
