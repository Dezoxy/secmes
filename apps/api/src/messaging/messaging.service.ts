import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant, type Tx } from '../db/index.js';
import type { ListMessagesQuery, SendMessage } from './messaging.schemas.js';

export interface CreatedConversation {
  conversationId: string;
}

export interface SentMessage {
  messageId: string;
  createdAt: string;
  /** true when an idempotent retry matched an existing (sender, clientMessageId) — nothing new stored. */
  deduplicated: boolean;
}

/** One fetched message — CIPHERTEXT ONLY plus routing metadata; the server never decrypts `ciphertext`. */
export interface FetchedMessage {
  id: string;
  senderUserId: string;
  clientMessageId: string;
  ciphertext: string;
  alg: string;
  epoch: number;
  attachmentObjectKey: string | null;
  createdAt: string;
}

export interface MessagePage {
  messages: FetchedMessage[];
  /** Cursor (last message id) to pass as `after` for the next page, or null when the page wasn't full. */
  nextCursor: string | null;
}

// Validates each raw fetched row so a schema drift on this read path fails loudly. `epoch` (int8) and
// `created_at` (timestamptz) come back from the driver as string/Date — coerce them.
const MessageRowSchema = z.object({
  id: z.string().uuid(),
  sender_user_id: z.string().uuid(),
  client_message_id: z.string().uuid(),
  ciphertext: z.string(),
  alg: z.string(),
  epoch: z.coerce.number().int().nonnegative(),
  attachment_object_key: z.string().nullable(),
  created_at: z.coerce.date(),
});

@Injectable()
export class MessagingService {
  /**
   * Resolve the VERIFIED caller (OIDC sub) to a tenant user id. Never trusts a client-supplied id, and
   * only resolves an **active** user — a soft-deleted/suspended member (offboarding sets `users.status`)
   * with a still-valid bearer token cannot create conversations or send, matching the directory filter.
   */
  private async requireUser(tx: Tx, sub: string): Promise<string> {
    const [user] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.externalIdentityId, sub), eq(schema.users.status, 'active')))
      .limit(1);
    if (!user) throw new BadRequestException('user not provisioned or not active');
    return user.id;
  }

  /**
   * Throw 404 unless `userId` is a member of `conversationId`. The SAME 404 covers a non-member and a
   * non-existent / RLS-hidden (wrong-tenant) conversation, so the API never reveals which conversations
   * exist to a non-member. This is the intra-tenant authz the schema/RLS deferred to the app layer.
   */
  private async requireMembership(tx: Tx, conversationId: string, userId: string): Promise<void> {
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
      await this.requireMembership(tx, conversationId, sender);

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

  /**
   * List a conversation's messages (CIPHERTEXT ONLY) in chronological order for a MEMBER. AUTHZ: same
   * membership 404 as send — non-members / cross-tenant / non-existent conversations leak nothing. The
   * server returns the opaque ciphertext + routing metadata verbatim; it never decrypts. Keyset
   * pagination on (created_at, id): pass the previous page's `nextCursor` as `after` to continue.
   */
  async listMessages(
    auth: VerifiedAuth,
    conversationId: string,
    query: ListMessagesQuery,
  ): Promise<MessagePage> {
    return withTenant(auth.tenantId, async (tx) => {
      const user = await this.requireUser(tx, auth.sub);
      await this.requireMembership(tx, conversationId, user);

      // Exclusive keyset cursor: rows strictly after the cursor row in (created_at, id) order. The cursor
      // row is looked up under RLS AND scoped to this conversation, so a foreign/invalid `after` resolves
      // to NULL → an empty page (safe). `conversationId`/`after` are bound parameters (not
      // string-interpolated) — no SQL injection.
      const cursor = query.after
        ? sql`and (m.created_at, m.id) > (select created_at, id from messages where id = ${query.after} and conversation_id = ${conversationId})`
        : sql``;
      const rows = (await tx.execute(sql`
        select m.id, m.sender_user_id, m.client_message_id, m.ciphertext, m.alg, m.epoch,
               m.attachment_object_key, m.created_at
        from messages m
        where m.conversation_id = ${conversationId} ${cursor}
        order by m.created_at asc, m.id asc
        limit ${query.limit}
      `)) as unknown as unknown[];

      const messages: FetchedMessage[] = rows.map((raw) => {
        // safeParse + content-free error: a ZodError can echo the offending value (which holds
        // `ciphertext`); never let message content reach an error/log (invariant #2).
        const parsed = MessageRowSchema.safeParse(raw);
        if (!parsed.success) throw new Error('message row shape drift');
        const r = parsed.data;
        return {
          id: r.id,
          senderUserId: r.sender_user_id,
          clientMessageId: r.client_message_id,
          ciphertext: r.ciphertext,
          alg: r.alg,
          epoch: r.epoch,
          attachmentObjectKey: r.attachment_object_key,
          createdAt: r.created_at.toISOString(),
        };
      });
      // A full page implies more may exist → hand back the last id as the next cursor.
      const last = messages.at(-1);
      const nextCursor = last && messages.length === query.limit ? last.id : null;
      return { messages, nextCursor };
    });
  }
}
