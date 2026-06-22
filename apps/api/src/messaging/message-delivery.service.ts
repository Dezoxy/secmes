import { ConflictException } from '@nestjs/common';
import { and, asc, eq, gt, inArray, max, min, sql } from 'drizzle-orm';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant } from '../db/index.js';
import { requireMembership, requireUser } from './membership.js';
import type { PushService } from '../push/push.service.js';
import type {
  CommitCreatedEvent,
  MemberRemovedEvent,
  MessageCreatedEvent,
  RealtimeBus,
} from '../realtime/realtime-bus.js';
import type { CommitBody, ListCommitsQuery, SendMessage } from './messaging.schemas.js';
import type { CommitResult, FetchedCommit, SentMessage } from './messaging.types.js';

// Message send + MLS commit chain (post/list). One of four internal collaborators the MessagingService
// façade composes (see messaging.service.ts); constructed by the façade, not a DI provider.
export class MessageDeliveryService {
  constructor(
    private readonly bus: RealtimeBus,
    private readonly push: PushService,
  ) {}

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
      const sender = await requireUser(tx, auth);
      await requireMembership(tx, conversationId, sender);

      // Idempotent-retry fast path: if this (conversation, sender, clientMessageId) was already
      // stored, return it immediately BEFORE the stale-epoch check. This prevents a retry from
      // being rejected with 409 simply because a commit advanced the epoch after the first send
      // succeeded but before the client received the acknowledgement.
      const [alreadyStored] = await tx
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
      if (alreadyStored) {
        return {
          result: {
            messageId: alreadyStored.id,
            createdAt: alreadyStored.createdAt.toISOString(),
            deduplicated: true,
          },
          event: null,
        };
      }

      // Epoch gate: reject messages at any epoch other than the current group epoch. A message
      // encrypted at an old epoch is undecryptable (MLS FS); one at a future epoch indicates the
      // client is ahead of the server-committed state and would be stored but undecryptable by peers.
      // Both are rejected so the client knows to drain commits or re-sync before retrying.
      // Gate applies ONLY to conversations that have at least one commit row (i.e. groups using the
      // staged-commit API). 1:1 conversations never write to conversation_commits — their MLS epoch
      // advances to 1 via addMember without a commit row, so maxEpoch stays -1 and the gate is skipped.
      const [epochRow] = await tx
        .select({ maxEpoch: max(schema.conversationCommits.epoch) })
        .from(schema.conversationCommits)
        .where(
          and(
            eq(schema.conversationCommits.tenantId, auth.tenantId),
            eq(schema.conversationCommits.conversationId, conversationId),
          ),
        );
      const maxEpoch =
        epochRow?.maxEpoch !== null && epochRow?.maxEpoch !== undefined
          ? Number(epochRow.maxEpoch)
          : -1;
      if (maxEpoch !== -1) {
        const expectedEpoch = maxEpoch + 1; // commit at N → group at N+1
        if (body.epoch !== expectedEpoch) {
          const direction = body.epoch < expectedEpoch ? 'stale' : 'future';
          throw new ConflictException(
            `${direction} epoch: client at ${String(body.epoch)}, group at ${String(expectedEpoch)} — ${
              direction === 'stale'
                ? 'drain commits before sending'
                : 'group has not yet advanced to this epoch'
            }`,
          );
        }
      }

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
      void this.push.notifyConversationMembers(
        auth.tenantId,
        conversationId,
        auth.sub,
        auth.userId,
      );
    }
    return result;
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
      const sender = await requireUser(tx, auth);
      await requireMembership(tx, conversationId, sender);

      // Contiguity guard: reject commits that skip epochs. A gap commit would poison MAX(epoch) for
      // the sendMessage stale-epoch gate, cause peer drain loops to halt at a missing slot, and let
      // a malicious member inject an arbitrarily large epoch that blocks all future messaging.
      // body.epoch === expectedEpoch → normal new commit; body.epoch < expectedEpoch → handled by
      // the unique constraint below (own idempotent retry or 409).
      // Empty commit log: accept any epoch as the first entry. 1:1 conversations and legacy
      // conversations (created before B1 commit-tracking) never wrote an epoch-0 commit row; their
      // local MLS group may be at epoch N > 0. sendMessage already skips the epoch gate for
      // empty-log conversations (maxEpoch === -1 path); postCommit mirrors that here.
      const [slotRow] = await tx
        .select({ currentMax: max(schema.conversationCommits.epoch) })
        .from(schema.conversationCommits)
        .where(
          and(
            eq(schema.conversationCommits.tenantId, auth.tenantId),
            eq(schema.conversationCommits.conversationId, conversationId),
          ),
        );
      const currentMax =
        slotRow?.currentMax !== null && slotRow?.currentMax !== undefined
          ? Number(slotRow.currentMax)
          : null;

      if (currentMax === null) {
        // Empty commit log: first commit may arrive at epoch > 0 for legacy conversations
        // (pre-B1 tracking; local MLS group advanced beyond epoch 0 without server-side records).
        // Cap at MAX_FIRST_EPOCH to prevent a malicious member from posting a huge sentinel epoch
        // that bricks future sendMessage (which uses maxEpoch + 1 as the expected next epoch).
        const MAX_FIRST_EPOCH = 65_535;
        if (body.epoch > MAX_FIRST_EPOCH) {
          throw new ConflictException(
            `first-commit epoch ${String(body.epoch)} exceeds maximum ${String(MAX_FIRST_EPOCH)}`,
          );
        }
      } else {
        const nextEpoch = currentMax + 1;
        if (body.epoch !== nextEpoch) {
          throw new ConflictException(
            `non-contiguous epoch: expected ${String(nextEpoch)}, got ${String(body.epoch)}`,
          );
        }
      }

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

        // Look up removed members' subs BEFORE deleting them (needed to evict their live WS room
        // subscriptions via MemberRemovedEvent post-commit). Both the Zitadel sub (externalIdentityId)
        // and the argus sub (argusid:<argus_id>) are collected so that sockets authenticated under
        // either token family are evicted — gateway matches on state.auth.sub.
        const removedSubs: string[] =
          body.removedUserIds.length > 0
            ? (
                await tx
                  .select({
                    sub: schema.users.externalIdentityId,
                    argusId: schema.users.argusId,
                  })
                  .from(schema.users)
                  .where(
                    and(
                      eq(schema.users.tenantId, auth.tenantId),
                      inArray(schema.users.id, body.removedUserIds),
                    ),
                  )
              ).flatMap((u) => [u.sub, `argusid:${u.argusId}`])
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

        // Validate each welcome: the device must exist in this tenant AND belong to the stated
        // recipient user. Skipping either check would let a member pair an arbitrary device with
        // a victim's userId, creating inconsistent membership state or misdirected join material.
        const welcomeDeviceIds = body.welcomes.map((w) => w.recipientDeviceId);
        const validDevices =
          welcomeDeviceIds.length > 0
            ? await tx
                .select({ id: schema.devices.id, userId: schema.devices.userId })
                .from(schema.devices)
                .where(
                  and(
                    eq(schema.devices.tenantId, auth.tenantId),
                    inArray(schema.devices.id, welcomeDeviceIds),
                  ),
                )
            : [];
        // Map deviceId → owning userId for O(1) cross-check below.
        const deviceOwner = new Map(validDevices.map((d) => [d.id, d.userId]));
        for (const w of body.welcomes) {
          if (deviceOwner.get(w.recipientDeviceId) !== w.recipientUserId) continue;
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
      void this.push.notifyConversationMembers(
        auth.tenantId,
        conversationId,
        auth.sub,
        auth.userId,
      );

      // Nudge welcome recipients — one WS push per unique added user per sub family (batch query).
      // Both the Zitadel sub and argus sub are emitted so sockets authenticated under either token
      // family receive the nudge.
      const uniqueRecipientIds = [...new Set(body.welcomes.map((w) => w.recipientUserId))];
      if (uniqueRecipientIds.length > 0) {
        const recipients = await withTenant(auth.tenantId, (tx) =>
          tx
            .select({
              id: schema.users.id,
              sub: schema.users.externalIdentityId,
              argusId: schema.users.argusId,
            })
            .from(schema.users)
            .where(
              and(
                eq(schema.users.tenantId, auth.tenantId),
                inArray(schema.users.id, uniqueRecipientIds),
              ),
            ),
        );
        for (const r of recipients) {
          for (const recipientSub of [r.sub, `argusid:${r.argusId}`]) {
            this.bus.emitWelcomeCreated({
              tenantId: auth.tenantId,
              conversationId,
              recipientSub,
            });
          }
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
   *
   * Also returns `oldestRetainedEpoch` — the smallest `epoch` still stored for the WHOLE conversation
   * (metadata only, never the commit blob) — so a catching-up client can tell a transient stall from a
   * pruned/lost commit (`oldestRetainedEpoch > localEpoch` ⇒ sync-lost). The controller surfaces it as
   * the `X-Oldest-Retained-Epoch` header.
   */
  async listCommits(
    auth: VerifiedAuth,
    conversationId: string,
    query: ListCommitsQuery,
  ): Promise<{ commits: FetchedCommit[]; oldestRetainedEpoch: number | null }> {
    return withTenant(auth.tenantId, async (tx) => {
      const user = await requireUser(tx, auth);
      await requireMembership(tx, conversationId, user);

      const rows = await tx
        .select({
          id: schema.conversationCommits.id,
          clientCommitId: schema.conversationCommits.clientCommitId,
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

      // Oldest commit epoch still retained for the WHOLE conversation (no afterEpoch filter), so a
      // catching-up client can tell a transient stall from a pruned gap: when oldestRetainedEpoch >
      // its local epoch, the commit it needs is gone and will never arrive (sync-lost). Metadata only —
      // never reads the commit blob (crypto-blind). Same RLS-scoped transaction → one round trip, no
      // cross-tenant leak. `null` when the conversation has no commits (e.g. a 1:1 that never committed).
      const [oldestRow] = await tx
        .select({ epoch: min(schema.conversationCommits.epoch) })
        .from(schema.conversationCommits)
        .where(
          and(
            eq(schema.conversationCommits.tenantId, auth.tenantId),
            eq(schema.conversationCommits.conversationId, conversationId),
          ),
        );
      const oldestRetainedEpoch =
        oldestRow?.epoch === null || oldestRow?.epoch === undefined
          ? null
          : Number(oldestRow.epoch);

      return {
        commits: rows.map((r) => ({
          id: r.id,
          clientCommitId: r.clientCommitId,
          epoch: Number(r.epoch),
          senderUserId: r.senderUserId,
          commit: r.commit,
          createdAt: r.createdAt.toISOString(),
        })),
        oldestRetainedEpoch,
      };
    });
  }
}
