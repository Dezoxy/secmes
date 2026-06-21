import { BadRequestException, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant } from '../db/index.js';
import { requireMembership, requireUser } from './membership.js';
import type { RealtimeBus } from '../realtime/realtime-bus.js';
import type { ListMessagesQuery, RecordReceipt, SyncQuery } from './messaging.schemas.js';
import type {
  ConversationReceipt,
  FetchedMessage,
  MessagePage,
  SyncedMessage,
  SyncPage,
} from './messaging.types.js';

// Validates each raw fetched row so a schema drift on this read path fails loudly. `epoch` (int8) and
// `created_at` (timestamptz) come back from the driver as string/Date — coerce them.
const MessageRowSchema = z.object({
  id: z.string().uuid(),
  sender_user_id: z.string().uuid().nullable(), // null after GDPR erasure (migration 0020)
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

// Read/sync history + delivery receipts. One of four internal collaborators the MessagingService
// façade composes (see messaging.service.ts); constructed by the façade, not a DI provider.
export class MessageHistoryService {
  constructor(private readonly bus: RealtimeBus) {}

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
      const user = await requireUser(tx, auth);
      await requireMembership(tx, conversationId, user);

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
      const user = await requireUser(tx, auth);

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

  /**
   * Record the caller's delivery/read HIGH-WATER-MARK in a conversation (checkpoint 31). Metadata only.
   * AUTHZ: member-only (same 404 as messaging); the watermark is the VERIFIED caller's own (never client-
   * supplied), and `throughMessageId` must be a message IN this conversation. Monotonic: the watermark
   * advances forward only — a replayed/older message can't move it backward.
   */
  async recordReceipt(
    auth: VerifiedAuth,
    conversationId: string,
    body: RecordReceipt,
  ): Promise<void> {
    const userId = await withTenant(auth.tenantId, async (tx) => {
      const user = await requireUser(tx, auth);
      await requireMembership(tx, conversationId, user);

      // Fetch the watermark message's created_at as FULL microsecond text (the driver's JS Date is only
      // ms — too lossy: two same-ms messages would then order by random uuid, mis-advancing the watermark).
      const [m] = await tx
        .select({
          id: schema.messages.id,
          createdAtIso: sql<string>`to_char(${schema.messages.createdAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.id, body.throughMessageId),
            eq(schema.messages.conversationId, conversationId),
          ),
        )
        .limit(1);
      if (!m) throw new NotFoundException('message not found in conversation');

      // `col` is a VALIDATED enum ('delivered'|'read') — safe to splice as an identifier via sql.raw
      // (never user free-text). Advance only if the new (created_at, id) is later than the stored one.
      const c = sql.raw(body.status); // 'delivered' | 'read'
      await tx.execute(sql`
        insert into conversation_receipts
          (tenant_id, conversation_id, user_id, ${c}_through_message_id, ${c}_through_created_at, ${c}_at)
        values (${auth.tenantId}, ${conversationId}, ${user}, ${m.id}, ${m.createdAtIso}::timestamptz, now())
        on conflict (tenant_id, conversation_id, user_id) do update set
          ${c}_through_message_id = excluded.${c}_through_message_id,
          ${c}_through_created_at = excluded.${c}_through_created_at,
          ${c}_at = excluded.${c}_at,
          updated_at = now()
        where conversation_receipts.${c}_through_created_at is null
           or (excluded.${c}_through_created_at, excluded.${c}_through_message_id)
            > (conversation_receipts.${c}_through_created_at, conversation_receipts.${c}_through_message_id)
      `);
      return user; // the INTERNAL users.id — what GET /receipts returns + what the client matches on
    });

    // Fan the advance out to the conversation room so the OTHER members' sockets flip their delivery ticks
    // live (checkpoint 31). Metadata only (ids + status). `userId` is the INTERNAL users.id (NOT auth.sub,
    // the external OIDC subject) so it lines up with GET /receipts and the client's own identity. Emit
    // unconditionally: the upsert may have been a no-op (the watermark was already past), but the client
    // fold is monotonic (takes max), so re-announcing an unchanged watermark is harmless — and it avoids a
    // RETURNING round-trip just to gate the emit.
    this.bus.emitReceiptAdvanced({
      tenantId: auth.tenantId,
      conversationId,
      userId,
      status: body.status,
      throughMessageId: body.throughMessageId,
    });
  }

  /** Per-member delivery/read watermarks in a conversation (metadata). AUTHZ: member-only. */
  async getReceipts(auth: VerifiedAuth, conversationId: string): Promise<ConversationReceipt[]> {
    return withTenant(auth.tenantId, async (tx) => {
      const user = await requireUser(tx, auth);
      await requireMembership(tx, conversationId, user);

      // Drive from MEMBERS (left join receipts) so EVERY member is returned — a member who hasn't acked
      // yet appears with null watermarks (i.e. "not delivered/read"), not omitted. RLS scopes both tables.
      const rows = await tx
        .select({
          userId: schema.conversationMembers.userId,
          deliveredThroughMessageId: schema.conversationReceipts.deliveredThroughMessageId,
          deliveredAt: schema.conversationReceipts.deliveredAt,
          readThroughMessageId: schema.conversationReceipts.readThroughMessageId,
          readAt: schema.conversationReceipts.readAt,
        })
        .from(schema.conversationMembers)
        .leftJoin(
          schema.conversationReceipts,
          and(
            eq(
              schema.conversationReceipts.conversationId,
              schema.conversationMembers.conversationId,
            ),
            eq(schema.conversationReceipts.userId, schema.conversationMembers.userId),
          ),
        )
        .where(eq(schema.conversationMembers.conversationId, conversationId));

      return rows.map((r) => ({
        userId: r.userId,
        deliveredThroughMessageId: r.deliveredThroughMessageId,
        deliveredAt: r.deliveredAt ? r.deliveredAt.toISOString() : null,
        readThroughMessageId: r.readThroughMessageId,
        readAt: r.readAt ? r.readAt.toISOString() : null,
      }));
    });
  }
}
