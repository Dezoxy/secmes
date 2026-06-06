import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant, type Tx } from '../db/index.js';
import { RealtimeBus, type MessageCreatedEvent } from '../realtime/realtime-bus.js';
import type { ListMessagesQuery, SendMessage, SyncQuery } from './messaging.schemas.js';

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

/** A message from the cross-conversation catch-up sync — carries its `conversationId` (the stream is
 * interleaved across all the caller's conversations, so each item must say which one it belongs to). */
export interface SyncedMessage extends FetchedMessage {
  conversationId: string;
}

export interface SyncPage {
  messages: SyncedMessage[];
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

// The sync row adds the conversation id (cross-conversation stream) + a full-precision created_at text
// for the opaque cursor (the driver's JS Date is only ms — too lossy to page on).
const SyncRowSchema = MessageRowSchema.extend({
  conversation_id: z.string().uuid(),
  created_at_iso: z.string(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The sync cursor is an OPAQUE token carrying the (created_at, id) the client last saw — NOT a message
// id the server looks up. This avoids (a) an existence/timing oracle (no per-id lookup) and (b) breaking
// a client whose last-seen message is in a conversation they've since left (no membership dependency on
// the cursor). The client treats it as opaque and echoes back the previous page's nextCursor.
function encodeSyncCursor(createdAtIso: string, id: string): string {
  return Buffer.from(`${createdAtIso}|${id}`, 'utf8').toString('base64url');
}
function decodeSyncCursor(token: string): { createdAt: string; id: string } {
  const decoded = Buffer.from(token, 'base64url').toString('utf8');
  const sep = decoded.lastIndexOf('|');
  const createdAt = sep >= 0 ? decoded.slice(0, sep) : '';
  const id = sep >= 0 ? decoded.slice(sep + 1) : '';
  if (!UUID_RE.test(id) || Number.isNaN(Date.parse(createdAt))) {
    throw new BadRequestException('invalid cursor');
  }
  return { createdAt, id };
}

@Injectable()
export class MessagingService {
  constructor(private readonly bus: RealtimeBus) {}

  /** Is the verified caller a member of `conversationId`? Used by the realtime gateway's subscribe authz. */
  async isMember(auth: VerifiedAuth, conversationId: string): Promise<boolean> {
    return withTenant(auth.tenantId, async (tx) => {
      const user = await this.requireUser(tx, auth.sub);
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
    // Carry the fan-out event OUT of the transaction so we only emit AFTER it commits — otherwise the
    // gateway could push a 'message' frame before the row is durable (phantom delivery if the commit
    // fails) and a recipient that reacts by fetching could race the uncommitted write.
    const { result, event } = await withTenant(auth.tenantId, async (tx) => {
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
        const createdAt = inserted[0].createdAt.toISOString();
        return {
          result: { messageId: inserted[0].id, createdAt, deduplicated: false },
          // Only a genuinely-new insert announces for fan-out — an idempotent retry must not re-deliver.
          // CIPHERTEXT ONLY; the bus/gateway never see plaintext.
          event: {
            tenantId: auth.tenantId,
            conversationId,
            message: {
              id: inserted[0].id,
              senderUserId: sender,
              clientMessageId: body.clientMessageId,
              ciphertext: body.ciphertext,
              alg: body.alg,
              epoch: body.epoch,
              attachmentObjectKey: body.attachmentObjectKey ?? null,
              createdAt,
            },
          } satisfies MessageCreatedEvent,
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
        result: {
          messageId: existing.id,
          createdAt: existing.createdAt.toISOString(),
          deduplicated: true,
        },
        event: null,
      };
    });

    // Post-commit: the row is durable + visible to a subsequent fetch before any client is notified.
    if (event) this.bus.emitMessageCreated(event);
    return result;
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

  /**
   * Catch-up sync (checkpoint 30): the messages across ALL the caller's conversations after a cursor, in
   * chronological order, each tagged with its `conversationId`. A reconnecting client passes its last-seen
   * `nextCursor` to fetch everything it missed in one paginated stream (the durable `messages` table is
   * the offline queue). AUTHZ: the inner join to `conversation_members` (caller) under RLS means only
   * conversations the caller is a member of are returned — never another member's or tenant's messages.
   *
   * NOTE: this `(created_at, id)` keyset is an ORDERING building block, not a standalone no-loss
   * guarantee — a message committing late with an earlier `created_at` can fall behind the cursor. The
   * client's reconnect protocol (subscribe-first → sync → dedup by id → overlap the cursor) plus the WS
   * post-commit fan-out is what guarantees no missed messages. See realtime-delivery.md §6.
   */
  async syncMessages(auth: VerifiedAuth, query: SyncQuery): Promise<SyncPage> {
    // Decode the opaque cursor up front (throws 400 on a malformed token). The (created_at, id) is used
    // directly in the keyset — no message lookup, so it's neither an existence oracle nor dependent on
    // the caller still being a member of the cursor message's conversation. Bound params, no injection.
    const cursorPos = query.after ? decodeSyncCursor(query.after) : null;
    return withTenant(auth.tenantId, async (tx) => {
      const user = await this.requireUser(tx, auth.sub);

      const cursor = cursorPos
        ? sql`and (m.created_at, m.id) > (${cursorPos.createdAt}::timestamptz, ${cursorPos.id}::uuid)`
        : sql``;
      // `created_at_iso` is the FULL microsecond-precision timestamp as text (the JS Date the driver
      // returns is only millisecond — too lossy for the cursor, which would then never advance past its
      // own row). It's used solely to build the opaque cursor; the response `createdAt` uses the Date.
      const rows = (await tx.execute(sql`
        select m.id, m.conversation_id, m.sender_user_id, m.client_message_id, m.ciphertext, m.alg,
               m.epoch, m.attachment_object_key, m.created_at,
               to_char(m.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_iso
        from messages m
        join conversation_members cm
          on cm.conversation_id = m.conversation_id and cm.user_id = ${user}
        where true ${cursor}
        order by m.created_at asc, m.id asc
        limit ${query.limit}
      `)) as unknown as unknown[];

      const parsedRows = rows.map((raw) => {
        const parsed = SyncRowSchema.safeParse(raw); // content-free error (never echo ciphertext)
        if (!parsed.success) throw new Error('message row shape drift');
        return parsed.data;
      });
      const messages: SyncedMessage[] = parsedRows.map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        senderUserId: r.sender_user_id,
        clientMessageId: r.client_message_id,
        ciphertext: r.ciphertext,
        alg: r.alg,
        epoch: r.epoch,
        attachmentObjectKey: r.attachment_object_key,
        createdAt: r.created_at.toISOString(),
      }));
      // `nextCursor` is the durable RESUME token positioned at this page's last message — returned
      // whenever the page has any messages (NOT only on a full page), so a client that catches up on a
      // partial final page can still persist its progress and resume later from exactly there. It's null
      // only for an empty page (nothing after the cursor → the client keeps its prior cursor). The client
      // decides whether to keep paging by whether it received a full page (`messages.length === limit`).
      const lastRow = parsedRows.at(-1);
      const nextCursor = lastRow ? encodeSyncCursor(lastRow.created_at_iso, lastRow.id) : null;
      return { messages, nextCursor };
    });
  }
}
