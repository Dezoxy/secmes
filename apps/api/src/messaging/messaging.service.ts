import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant, type Tx } from '../db/index.js';
import type { SendMessage } from './messaging.schemas.js';

export interface CreatedConversation {
  conversationId: string;
}

export interface SentMessage {
  messageId: string;
  createdAt: string;
  /** true when an idempotent retry matched an existing (sender, clientMessageId) — nothing new stored. */
  deduplicated: boolean;
}

@Injectable()
export class MessagingService {
  /** Resolve the VERIFIED caller (OIDC sub) to a tenant user id. Never trusts a client-supplied id. */
  private async requireUser(tx: Tx, sub: string): Promise<string> {
    const [user] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.externalIdentityId, sub))
      .limit(1);
    if (!user) throw new BadRequestException('user not provisioned; sign in first');
    return user.id;
  }

  /**
   * Create a conversation owned by the caller; add the caller + `memberUserIds` as members. Member ids
   * must be users IN THE CALLER'S TENANT — the composite FK `(tenant_id, user_id) → users(tenant_id, id)`
   * rejects a non-existent or cross-tenant id (surfaced as 400). No message content is involved.
   */
  async createConversation(
    auth: VerifiedAuth,
    memberUserIds: string[],
  ): Promise<CreatedConversation> {
    return withTenant(auth.tenantId, async (tx) => {
      const creator = await this.requireUser(tx, auth.sub);

      const [conv] = await tx
        .insert(schema.conversations)
        .values({ tenantId: auth.tenantId, createdBy: creator })
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

  /**
   * Store a message in `conversationId` on behalf of the verified caller. AUTHZ: the caller must be a
   * member of the conversation — non-members (and non-existent / cross-tenant conversations) get 404 so
   * the API leaks nothing about which conversations exist. The body is CIPHERTEXT ONLY; the server never
   * decrypts it. Idempotent on (tenant, sender, clientMessageId): a retry returns the existing message.
   */
  async sendMessage(
    auth: VerifiedAuth,
    conversationId: string,
    body: SendMessage,
  ): Promise<SentMessage> {
    return withTenant(auth.tenantId, async (tx) => {
      const sender = await this.requireUser(tx, auth.sub);

      const [member] = await tx
        .select({ id: schema.conversationMembers.id })
        .from(schema.conversationMembers)
        .where(
          and(
            eq(schema.conversationMembers.conversationId, conversationId),
            eq(schema.conversationMembers.userId, sender),
          ),
        )
        .limit(1);
      // Same 404 whether the conversation doesn't exist (RLS-hidden / wrong tenant) or the caller simply
      // isn't a member — never reveal which conversations exist to a non-member.
      if (!member) throw new NotFoundException('conversation not found');

      const inserted = await tx
        .insert(schema.messages)
        .values({
          tenantId: auth.tenantId,
          conversationId,
          senderUserId: sender,
          clientMessageId: body.clientMessageId,
          ciphertext: body.ciphertext,
          alg: body.alg,
          epoch: BigInt(body.epoch),
          attachmentObjectKey: body.attachmentObjectKey ?? null,
        })
        .onConflictDoNothing() // (tenant, sender, client_message_id) unique → idempotent retry
        .returning({ id: schema.messages.id, createdAt: schema.messages.createdAt });

      if (inserted[0]) {
        return {
          messageId: inserted[0].id,
          createdAt: inserted[0].createdAt.toISOString(),
          deduplicated: false,
        };
      }

      // Conflict: this (conversation, sender, clientMessageId) was already stored — return that row,
      // store nothing new. Scoped to the conversation to match the idempotency index (0008).
      const [existing] = await tx
        .select({ id: schema.messages.id, createdAt: schema.messages.createdAt })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.conversationId, conversationId),
            eq(schema.messages.senderUserId, sender),
            eq(schema.messages.clientMessageId, body.clientMessageId),
          ),
        )
        .limit(1);
      if (!existing) throw new Error('idempotency conflict but no existing message found');
      return {
        messageId: existing.id,
        createdAt: existing.createdAt.toISOString(),
        deduplicated: true,
      };
    });
  }
}
