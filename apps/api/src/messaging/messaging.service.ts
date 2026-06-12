import { verifyWelcomeConsume, verifyWelcomeFetch } from '@argus/crypto/device-proof';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant, type Tx } from '../db/index.js';
import { requireMembership, requireUser } from './membership.js';
import { PushService } from '../push/push.service.js';
import {
  RealtimeBus,
  type CommitCreatedEvent,
  type MemberRemovedEvent,
  type MessageCreatedEvent,
} from '../realtime/realtime-bus.js';
import type {
  CommitBody,
  DeliverWelcome,
  ListCommitsQuery,
  ListMessagesQuery,
  RecordReceipt,
  SendMessage,
  SyncQuery,
} from './messaging.schemas.js';

export interface CreatedConversation {
  conversationId: string;
}

/** A pending MLS Welcome's METADATA, listed on connect. The opaque blobs are fetched SEPARATELY via a
 * device proof-of-possession (see WelcomeMaterial / getWelcomeMaterial), so listing leaks no join
 * material — a sibling session that spoofs a deviceId sees only ids, never another device's sealed blobs. */
export interface PendingWelcome {
  id: string;
  conversationId: string;
  /** The verified member who delivered it (set server-side) — the client names the conversation with it. */
  senderUserId: string;
  createdAt: string;
}

/** The opaque join material for one welcome — CIPHERTEXT ONLY (HPKE-sealed to the recipient device). */
export interface WelcomeMaterial {
  welcome: string;
  ratchetTree: string;
}

export interface SentMessage {
  messageId: string;
  createdAt: string;
  /** true when an idempotent retry matched an existing (sender, clientMessageId) — nothing new stored. */
  deduplicated: boolean;
}

export interface CommitResult {
  id: string;
  epoch: number;
  deduplicated: boolean;
}

/** One fetched commit — opaque mls_private_message base64 + routing metadata. Server never decrypts. */
export interface FetchedCommit {
  id: string;
  epoch: number;
  senderUserId: string | null;
  commit: string;
  createdAt: string;
}

/** One fetched message — CIPHERTEXT ONLY plus routing metadata; the server never decrypts `ciphertext`. */
export interface FetchedMessage {
  id: string;
  /** null when the sender has exercised their GDPR right to erasure (account deleted). */
  senderUserId: string | null;
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

/** A member's delivery/read high-water-marks in a conversation (metadata; checkpoint 31). */
export interface ConversationReceipt {
  userId: string;
  deliveredThroughMessageId: string | null;
  deliveredAt: string | null;
  readThroughMessageId: string | null;
  readAt: string | null;
}

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

@Injectable()
export class MessagingService {
  constructor(
    private readonly bus: RealtimeBus,
    private readonly push: PushService,
  ) {}

  /** Is the verified caller a member of `conversationId`? Used by the realtime gateway's subscribe authz. */
  async isMember(auth: VerifiedAuth, conversationId: string): Promise<boolean> {
    return withTenant(auth.tenantId, async (tx) => {
      const user = await requireUser(tx, auth.sub);
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
  ): Promise<CreatedConversation> {
    return withTenant(auth.tenantId, async (tx) => {
      const creator = await requireUser(tx, auth.sub);

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
   * Deliver an MLS Welcome to a newly-added member — the live-loop relay between the key directory (#19)
   * and a live group. In ONE transaction the verified caller (an existing member) adds `recipientUserId`
   * to the conversation and stores the opaque Welcome + RatchetTree FOR them. AUTHZ: the caller must
   * already be a member (same membership 404 as send — a non-member / cross-tenant / non-existent
   * conversation leaks nothing). The recipient must be a user IN THE CALLER'S TENANT, and
   * `recipientDeviceId` one of THAT user's devices — the Welcome is HPKE-sealed to that device's claimed
   * KeyPackage (composite FKs → 400). `welcome`/`ratchetTree` are CIPHERTEXT ONLY — the server never
   * decrypts them; `senderUserId` is the VERIFIED caller, never client input.
   */
  async deliverWelcome(
    auth: VerifiedAuth,
    conversationId: string,
    body: DeliverWelcome,
  ): Promise<{ welcomeId: string }> {
    const { welcomeId, recipientSub } = await withTenant(auth.tenantId, async (tx) => {
      const sender = await requireUser(tx, auth.sub);
      await requireMembership(tx, conversationId, sender);

      // Add the recipient as a member (idempotent — re-delivering to an existing member is a no-op add).
      // The composite FK (tenant_id, user_id) → users(tenant_id, id) rejects an unknown / cross-tenant
      // recipient id; surfaced as 400 (no id echoed). A caught FK error aborts the tx, so we never
      // proceed to the welcome insert on a bad recipient.
      try {
        await tx
          .insert(schema.conversationMembers)
          .values({ tenantId: auth.tenantId, conversationId, userId: body.recipientUserId })
          .onConflictDoNothing();
      } catch {
        throw new BadRequestException('recipient user id is invalid for this tenant');
      }

      // Store the opaque Welcome + RatchetTree for the recipient DEVICE. The composite FK
      // (tenant_id, recipient_user_id, recipient_device_id) → devices rejects a device that isn't the
      // recipient's (or an unknown one) → 400 (no id echoed). A caught FK error aborts the tx, rolling
      // back the member add too (atomic).
      let rows: { id: string }[];
      try {
        rows = await tx
          .insert(schema.conversationWelcomes)
          .values({
            tenantId: auth.tenantId,
            conversationId,
            recipientUserId: body.recipientUserId,
            recipientDeviceId: body.recipientDeviceId,
            senderUserId: sender,
            welcome: body.welcome,
            ratchetTree: body.ratchetTree,
          })
          .returning({ id: schema.conversationWelcomes.id });
      } catch {
        throw new BadRequestException('recipient device id is invalid for this tenant');
      }
      const welcome = rows[0];
      if (!welcome) throw new Error('welcome insert returned no row');

      // Resolve the recipient's external subject for the post-commit realtime nudge — an authed socket is
      // keyed by its verified `sub`, not the argus user id. Same-tx read; the FK above already proved the
      // recipient exists in this tenant.
      const [recipient] = await tx
        .select({ sub: schema.users.externalIdentityId })
        .from(schema.users)
        .where(
          and(eq(schema.users.tenantId, auth.tenantId), eq(schema.users.id, body.recipientUserId)),
        )
        .limit(1);
      return { welcomeId: welcome.id, recipientSub: recipient?.sub ?? null };
    });

    // Post-commit (same pattern as sendMessage): the Welcome row is durable BEFORE any client is nudged,
    // so a recipient that reacts immediately always finds it. Content-free: ids + the recipient subject
    // only. Best-effort — join-on-connect remains the fallback if the recipient is offline.
    if (recipientSub) {
      this.bus.emitWelcomeCreated({ tenantId: auth.tenantId, conversationId, recipientSub });
    }
    return { welcomeId };
  }

  /**
   * The calling DEVICE's PENDING welcomes across every conversation it was added to (listed on connect).
   * METADATA ONLY — ids + conversationId, NOT the opaque blobs. The actual join material is fetched
   * separately with a device proof (`getWelcomeMaterial`), so even though `deviceId` here is client-asserted
   * (the token carries the user, not the device), a sibling session that spoofs a deviceId sees only the
   * ids of another device's pending welcomes, never its sealed join material. Scoped to
   * `recipient_user_id = the verified caller` (authz boundary, RLS-tenant) AND `recipient_device_id`.
   */
  async listMyWelcomes(
    auth: VerifiedAuth,
    deviceId: string,
    limit = 50,
  ): Promise<PendingWelcome[]> {
    return withTenant(auth.tenantId, async (tx) => {
      const me = await requireUser(tx, auth.sub);
      // Oldest-first + bounded `limit`: the response can't grow without limit if a member spams an offline
      // device. The client fetches each welcome's material (with a proof), joins, consumes, then re-fetches.
      const rows = await tx
        .select({
          id: schema.conversationWelcomes.id,
          conversationId: schema.conversationWelcomes.conversationId,
          // The VERIFIED deliverer (set server-side at deliver) — lets the recipient name the conversation
          // via the directory. Nothing new leaks: messages already carry senderUserId to recipients.
          senderUserId: schema.conversationWelcomes.senderUserId,
          createdAt: schema.conversationWelcomes.createdAt,
        })
        .from(schema.conversationWelcomes)
        .where(
          and(
            eq(schema.conversationWelcomes.recipientUserId, me),
            eq(schema.conversationWelcomes.recipientDeviceId, deviceId),
          ),
        )
        .orderBy(asc(schema.conversationWelcomes.createdAt))
        .limit(limit);
      return rows.map((r) => ({
        id: r.id,
        conversationId: r.conversationId,
        senderUserId: r.senderUserId,
        createdAt: r.createdAt.toISOString(),
      }));
    });
  }

  /**
   * Verify a device proof-of-possession for a welcome op, scoped to the VERIFIED caller. Loads the
   * proving device's PUBLIC signature key (must be a device of `me`, RLS-tenant) and verifies the
   * Ed25519 `proof` over (deviceId, welcomeId) with `verifyProof` (consume- or fetch-domain). Any failure
   * → the SAME opaque 404 (unknown/foreign device, bad proof). Verifying a public-key signature is an
   * auth check, not content decryption — the server stays crypto-blind. Returns the resolved caller id.
   */
  private async requireDeviceProof(
    tx: Tx,
    me: string,
    deviceId: string,
    welcomeId: string,
    proof: string,
    verifyProof: (pub: Uint8Array, deviceId: string, welcomeId: string, sig: Uint8Array) => boolean,
  ): Promise<void> {
    const [device] = await tx
      .select({ signaturePublicKey: schema.devices.signaturePublicKey })
      .from(schema.devices)
      .where(and(eq(schema.devices.id, deviceId), eq(schema.devices.userId, me)))
      .limit(1);
    if (!device) throw new NotFoundException('welcome not found');
    const proven = verifyProof(
      Buffer.from(device.signaturePublicKey, 'base64'),
      deviceId,
      welcomeId,
      Buffer.from(proof, 'base64url'),
    );
    if (!proven) throw new NotFoundException('welcome not found');
  }

  /**
   * Fetch one welcome's opaque join material (welcome + ratchetTree) for the calling device. Listing is
   * metadata-only; the blobs come from HERE, gated by a device **fetch-proof** — so only the device the
   * Welcome is sealed to can pull its join material, not a sibling session that spoofs the deviceId. CIPHERTEXT
   * ONLY (the server never decrypts). Scoped to `recipient_user_id = caller` AND `recipient_device_id`; any
   * failure (bad proof, foreign / other-device / consumed welcome) → the SAME opaque 404.
   */
  async getWelcomeMaterial(
    auth: VerifiedAuth,
    welcomeId: string,
    deviceId: string,
    proof: string,
  ): Promise<WelcomeMaterial> {
    return withTenant(auth.tenantId, async (tx) => {
      const me = await requireUser(tx, auth.sub);
      await this.requireDeviceProof(tx, me, deviceId, welcomeId, proof, verifyWelcomeFetch);

      const [row] = await tx
        .select({
          welcome: schema.conversationWelcomes.welcome,
          ratchetTree: schema.conversationWelcomes.ratchetTree,
        })
        .from(schema.conversationWelcomes)
        .where(
          and(
            eq(schema.conversationWelcomes.id, welcomeId),
            eq(schema.conversationWelcomes.recipientUserId, me),
            eq(schema.conversationWelcomes.recipientDeviceId, deviceId),
          ),
        )
        .limit(1);
      if (!row) throw new NotFoundException('welcome not found');
      return { welcome: row.welcome, ratchetTree: row.ratchetTree };
    });
  }

  /**
   * Consume (delete) a welcome after the calling DEVICE has joined the group. The bearer token proves the
   * USER, not the device, so the caller must additionally **prove possession of the device's signature
   * private key**: `proof` is an Ed25519 signature over (deviceId, welcomeId) verified against the
   * device's PUBLIC signature key (key directory). This stops a sibling device/session of the SAME user
   * from deleting — and thereby destroying — another device's pending welcome by passing its id. The
   * delete is also scoped to `recipient_user_id = the verified caller` (authz boundary) AND
   * `recipient_device_id = deviceId`. Any failure → the SAME opaque 404 (unknown device, bad proof,
   * foreign / wrong-tenant / other-device / already-consumed welcome), so nothing is revealed.
   */
  async consumeWelcome(
    auth: VerifiedAuth,
    welcomeId: string,
    deviceId: string,
    proof: string,
  ): Promise<void> {
    await withTenant(auth.tenantId, async (tx) => {
      const me = await requireUser(tx, auth.sub);
      await this.requireDeviceProof(tx, me, deviceId, welcomeId, proof, verifyWelcomeConsume);

      const deleted = await tx
        .delete(schema.conversationWelcomes)
        .where(
          and(
            eq(schema.conversationWelcomes.id, welcomeId),
            eq(schema.conversationWelcomes.recipientUserId, me),
            eq(schema.conversationWelcomes.recipientDeviceId, deviceId),
          ),
        )
        .returning({ id: schema.conversationWelcomes.id });
      if (deleted.length === 0) throw new NotFoundException('welcome not found');
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
      const sender = await requireUser(tx, auth.sub);
      await requireMembership(tx, conversationId, sender);

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
    if (event) {
      this.bus.emitMessageCreated(event);
      // Fire-and-forget content-free push ping. Errors are caught inside notifyConversationMembers;
      // a push failure must never surface to the caller or delay the response.
      void this.push.notifyConversationMembers(auth.tenantId, conversationId, auth.sub);
    }
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
      const user = await requireUser(tx, auth.sub);
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
      const user = await requireUser(tx, auth.sub);

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
      const user = await requireUser(tx, auth.sub);
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

  /**
   * Submit a staged membership commit to win the epoch slot for `conversationId`.
   *
   * Invariant #1: the `commit` field is an opaque base64 mls_private_message — the server never
   * decrypts it. Membership changes are applied to `conversation_members` via the DECLARED delta
   * (`addedUserIds`, `removedUserIds`); the cryptographic truth is in the commit frame itself
   * (see threat model §T2).
   *
   * Returns 200 on first win or on own idempotent retry. Throws ConflictException (409) if another
   * member won the slot at this epoch first.
   */
  async postCommit(
    auth: VerifiedAuth,
    conversationId: string,
    body: CommitBody,
  ): Promise<CommitResult> {
    const { result, event, removedSubs } = await withTenant(auth.tenantId, async (tx) => {
      const sender = await requireUser(tx, auth.sub);
      await requireMembership(tx, conversationId, sender);

      // Attempt to insert — the UNIQUE (tenant_id, conversation_id, epoch) constraint is the server-side
      // epoch lock. onConflictDoNothing is used here because we need to distinguish two conflict types:
      // (a) epoch slot occupied by another member → 409; (b) own idempotent retry → 200 deduplicated.
      // We distinguish them by checking the rows-inserted count and then querying for the own row.
      const inserted = await tx
        .insert(schema.conversationCommits)
        .values({
          tenantId: auth.tenantId,
          conversationId,
          senderUserId: sender,
          clientCommitId: body.clientCommitId,
          epoch: BigInt(body.epoch),
          commit: body.commit,
        })
        .onConflictDoNothing()
        .returning({
          id: schema.conversationCommits.id,
          createdAt: schema.conversationCommits.createdAt,
        });

      if (inserted[0]) {
        // Pre-validate added user IDs to avoid FK violations that abort the tx. A PostgreSQL FK
        // violation puts the connection in an error state; a JS catch only handles the Node error,
        // not the Postgres tx-aborted state — all subsequent statements would fail. Unknown /
        // cross-tenant IDs are silently skipped (crypto truth is in the MLS commit frame, §T2).
        const validAddedUsers =
          body.addedUserIds.length > 0
            ? await tx
                .select({ id: schema.users.id })
                .from(schema.users)
                .where(
                  and(
                    eq(schema.users.tenantId, auth.tenantId),
                    inArray(schema.users.id, body.addedUserIds),
                  ),
                )
            : [];
        const validAddedIds = new Set(validAddedUsers.map((u) => u.id));
        for (const userId of body.addedUserIds) {
          if (!validAddedIds.has(userId)) continue;
          await tx
            .insert(schema.conversationMembers)
            .values({ tenantId: auth.tenantId, conversationId, userId })
            .onConflictDoNothing();
        }

        // Look up removed members' external subs BEFORE deleting them (needed to evict their live
        // WS room subscriptions via MemberRemovedEvent post-commit).
        const removedSubs: string[] =
          body.removedUserIds.length > 0
            ? (
                await tx
                  .select({ sub: schema.users.externalIdentityId })
                  .from(schema.users)
                  .where(
                    and(
                      eq(schema.users.tenantId, auth.tenantId),
                      inArray(schema.users.id, body.removedUserIds),
                    ),
                  )
              ).map((u) => u.sub)
            : [];
        if (body.removedUserIds.length > 0) {
          await tx.delete(schema.conversationMembers).where(
            and(
              eq(schema.conversationMembers.tenantId, auth.tenantId),
              eq(schema.conversationMembers.conversationId, conversationId),
              sql`${schema.conversationMembers.userId} = ANY(ARRAY[${sql.join(
                body.removedUserIds.map((id) => sql`${id}::uuid`),
                sql`, `,
              )}])`,
            ),
          );
        }

        // Pre-validate welcome device IDs (same FK posture as addedUserIds above).
        const welcomeDeviceIds = body.welcomes.map((w) => w.recipientDeviceId);
        const validDevices =
          welcomeDeviceIds.length > 0
            ? await tx
                .select({ id: schema.devices.id })
                .from(schema.devices)
                .where(
                  and(
                    eq(schema.devices.tenantId, auth.tenantId),
                    inArray(schema.devices.id, welcomeDeviceIds),
                  ),
                )
            : [];
        const validDeviceIds = new Set(validDevices.map((d) => d.id));
        for (const w of body.welcomes) {
          if (!validDeviceIds.has(w.recipientDeviceId)) continue;
          await tx
            .insert(schema.conversationWelcomes)
            .values({
              tenantId: auth.tenantId,
              conversationId,
              recipientUserId: w.recipientUserId,
              recipientDeviceId: w.recipientDeviceId,
              senderUserId: sender,
              welcome: w.welcome,
              ratchetTree: w.ratchetTree,
            })
            .onConflictDoNothing();
        }

        const createdAt = inserted[0].createdAt.toISOString();
        return {
          result: { id: inserted[0].id, epoch: body.epoch, deduplicated: false },
          event: {
            tenantId: auth.tenantId,
            conversationId,
            epoch: body.epoch,
            senderUserId: sender,
            commitId: inserted[0].id,
            createdAt,
          } satisfies CommitCreatedEvent,
          removedSubs,
        };
      }

      // Conflict — check if it's our own retry or another member's win.
      const [existing] = await tx
        .select({
          id: schema.conversationCommits.id,
          senderUserId: schema.conversationCommits.senderUserId,
          clientCommitId: schema.conversationCommits.clientCommitId,
        })
        .from(schema.conversationCommits)
        .where(
          and(
            eq(schema.conversationCommits.tenantId, auth.tenantId),
            eq(schema.conversationCommits.conversationId, conversationId),
            eq(schema.conversationCommits.epoch, BigInt(body.epoch)),
          ),
        )
        .limit(1);

      if (
        existing &&
        existing.senderUserId !== null &&
        existing.senderUserId === sender &&
        existing.clientCommitId === body.clientCommitId
      ) {
        // Own idempotent retry.
        return {
          result: { id: existing.id, epoch: body.epoch, deduplicated: true },
          event: null,
          removedSubs: [],
        };
      }

      // Another member won this epoch slot.
      throw new ConflictException('epoch slot already occupied');
    });

    // Post-commit: notify all conversation members about the new commit (metadata only, no ciphertext).
    if (event) {
      this.bus.emitCommitCreated(event);
      void this.push.notifyConversationMembers(auth.tenantId, conversationId, auth.sub);

      // Nudge welcome recipients — one WS push per unique added user (batch to a single query).
      const uniqueRecipientIds = [...new Set(body.welcomes.map((w) => w.recipientUserId))];
      if (uniqueRecipientIds.length > 0) {
        const recipients = await withTenant(auth.tenantId, (tx) =>
          tx
            .select({ id: schema.users.id, sub: schema.users.externalIdentityId })
            .from(schema.users)
            .where(
              and(
                eq(schema.users.tenantId, auth.tenantId),
                inArray(schema.users.id, uniqueRecipientIds),
              ),
            ),
        );
        for (const r of recipients) {
          this.bus.emitWelcomeCreated({
            tenantId: auth.tenantId,
            conversationId,
            recipientSub: r.sub,
          });
        }
      }

      // Evict removed members from their live WS room subscriptions so they stop receiving
      // metadata pushes immediately after the commit lands (no wait for disconnect/reconnect).
      if (removedSubs.length > 0) {
        this.bus.emitMemberRemoved({
          tenantId: auth.tenantId,
          conversationId,
          removedSubs,
        } satisfies MemberRemovedEvent);
      }
    }
    return result;
  }

  /**
   * Drain commits after `afterEpoch` for a conversation (the client's catch-up / epoch-advance path).
   * OPAQUE COMMIT BYTES ONLY — ciphertext only, server never decrypts. Member-only.
   */
  async listCommits(
    auth: VerifiedAuth,
    conversationId: string,
    query: ListCommitsQuery,
  ): Promise<FetchedCommit[]> {
    return withTenant(auth.tenantId, async (tx) => {
      const user = await requireUser(tx, auth.sub);
      await requireMembership(tx, conversationId, user);

      const rows = await tx
        .select({
          id: schema.conversationCommits.id,
          epoch: schema.conversationCommits.epoch,
          senderUserId: schema.conversationCommits.senderUserId,
          commit: schema.conversationCommits.commit,
          createdAt: schema.conversationCommits.createdAt,
        })
        .from(schema.conversationCommits)
        .where(
          and(
            eq(schema.conversationCommits.tenantId, auth.tenantId),
            eq(schema.conversationCommits.conversationId, conversationId),
            gt(schema.conversationCommits.epoch, BigInt(query.afterEpoch)),
          ),
        )
        .orderBy(asc(schema.conversationCommits.epoch))
        .limit(query.limit);

      return rows.map((r) => ({
        id: r.id,
        epoch: Number(r.epoch),
        senderUserId: r.senderUserId,
        commit: r.commit,
        createdAt: r.createdAt.toISOString(),
      }));
    });
  }

  /** Per-member delivery/read watermarks in a conversation (metadata). AUTHZ: member-only. */
  async getReceipts(auth: VerifiedAuth, conversationId: string): Promise<ConversationReceipt[]> {
    return withTenant(auth.tenantId, async (tx) => {
      const user = await requireUser(tx, auth.sub);
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
