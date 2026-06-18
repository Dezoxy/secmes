import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { and, count, eq, max, min, or, sql } from 'drizzle-orm';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { BlobStore } from '../blob/blob-store.js';
import { schema, withRouting, withTenant, type Tx } from '../db/index.js';
import type { MeExport } from '@argus/contracts';

@Injectable()
export class GdprService {
  private readonly logger = new Logger(GdprService.name);

  constructor(private readonly blobStore: BlobStore) {}

  /**
   * GDPR Art. 20 — data portability. Returns all METADATA the server holds about the caller.
   * NEVER returns ciphertext, content keys, or message plaintext — the server is crypto-blind.
   * Each category is fetched in its own pool connection (parallel withTenant calls).
   */
  async exportAccount(auth: VerifiedAuth): Promise<MeExport> {
    const [
      profile,
      devices,
      conversations,
      messageSummaryRaw,
      attachments,
      pushSubs,
      auditEvents,
      invitesCreated,
    ] = await Promise.all([
      // Profile
      withTenant(auth.tenantId, async (tx) => {
        const [row] = await tx
          .select({
            id: schema.users.id,
            tenantId: schema.users.tenantId,
            argusId: schema.users.argusId,
            displayName: schema.users.displayName,
            avatarSeed: schema.users.avatarSeed,
            role: schema.users.role,
            status: schema.users.status,
            createdAt: schema.users.createdAt,
          })
          .from(schema.users)
          .where(
            and(
              auth.userId
                ? eq(schema.users.id, auth.userId)
                : eq(schema.users.externalIdentityId, auth.sub),
              eq(schema.users.tenantId, auth.tenantId),
            ),
          )
          .limit(1);
        return row ?? null;
      }),

      // Devices
      withTenant(auth.tenantId, async (tx) => {
        const user = await resolveUserId(tx, auth);
        if (!user) return [];
        return tx
          .select({ id: schema.devices.id, createdAt: schema.devices.createdAt })
          .from(schema.devices)
          .where(
            and(eq(schema.devices.tenantId, auth.tenantId), eq(schema.devices.userId, user.id)),
          );
      }),

      // Conversations (as member)
      withTenant(auth.tenantId, async (tx) => {
        const user = await resolveUserId(tx, auth);
        if (!user) return [];
        const rows = await tx
          .select({
            id: schema.conversations.id,
            createdAt: schema.conversations.createdAt,
          })
          .from(schema.conversations)
          .innerJoin(
            schema.conversationMembers,
            and(
              eq(schema.conversationMembers.conversationId, schema.conversations.id),
              eq(schema.conversationMembers.tenantId, auth.tenantId),
              eq(schema.conversationMembers.userId, user.id),
            ),
          )
          .where(eq(schema.conversations.tenantId, auth.tenantId));
        return rows;
      }),

      // Message counts per conversation
      withTenant(auth.tenantId, async (tx) => {
        const user = await resolveUserId(tx, auth);
        if (!user) return [];
        return tx
          .select({
            conversationId: schema.messages.conversationId,
            count: count(),
            firstAt: min(schema.messages.createdAt),
            lastAt: max(schema.messages.createdAt),
          })
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.tenantId, auth.tenantId),
              eq(schema.messages.senderUserId, user.id),
            ),
          )
          .groupBy(schema.messages.conversationId);
      }),

      // Attachments
      withTenant(auth.tenantId, async (tx) => {
        const user = await resolveUserId(tx, auth);
        if (!user) return [];
        return tx
          .select({
            id: schema.attachments.id,
            conversationId: schema.attachments.conversationId,
            objectKey: schema.attachments.objectKey,
            byteSize: schema.attachments.byteSize,
            createdAt: schema.attachments.createdAt,
            expiresAt: schema.attachments.expiresAt,
          })
          .from(schema.attachments)
          .where(
            and(
              eq(schema.attachments.tenantId, auth.tenantId),
              eq(schema.attachments.uploadedBy, user.id),
            ),
          );
      }),

      // Push subscriptions (endpoint prefix only — never the full capability URL)
      withTenant(auth.tenantId, async (tx) => {
        const user = await resolveUserId(tx, auth);
        if (!user) return [];
        return tx
          .select({
            id: schema.pushSubscriptions.id,
            endpoint: schema.pushSubscriptions.endpoint,
            createdAt: schema.pushSubscriptions.createdAt,
          })
          .from(schema.pushSubscriptions)
          .where(
            and(
              eq(schema.pushSubscriptions.tenantId, auth.tenantId),
              eq(schema.pushSubscriptions.userId, user.id),
            ),
          );
      }),

      // Audit events where actor = this identity (own activity only, not admin observations).
      // Both the Zitadel sub (externalIdentityId) and the argus sub (argusid:<users.id>) are
      // included so that users who have used both token families get a complete export.
      withTenant(auth.tenantId, async (tx) => {
        const user = await resolveUserId(tx, auth);
        if (!user) return [];
        return tx
          .select({
            id: schema.auditEvents.id,
            eventType: schema.auditEvents.eventType,
            createdAt: schema.auditEvents.createdAt,
            metadata: schema.auditEvents.metadata,
          })
          .from(schema.auditEvents)
          .where(
            and(
              eq(schema.auditEvents.tenantId, auth.tenantId),
              or(
                eq(schema.auditEvents.actorSub, user.externalIdentityId),
                eq(schema.auditEvents.actorSub, `argusid:${user.argusId}`),
              ),
            ),
          )
          .orderBy(schema.auditEvents.createdAt);
      }),

      // Invites created by this user
      withTenant(auth.tenantId, async (tx) => {
        const user = await resolveUserId(tx, auth);
        if (!user) return [];
        return tx
          .select({
            id: schema.tenantInvites.id,
            createdAt: schema.tenantInvites.createdAt,
            expiresAt: schema.tenantInvites.expiresAt,
            acceptedAt: schema.tenantInvites.acceptedAt,
            revokedAt: schema.tenantInvites.revokedAt,
          })
          .from(schema.tenantInvites)
          .where(
            and(
              eq(schema.tenantInvites.tenantId, auth.tenantId),
              eq(schema.tenantInvites.createdBy, user.id),
            ),
          );
      }),
    ]);

    if (!profile) {
      // User row was not found (not yet provisioned / already erased) — return minimal structure.
      return buildEmptyExport();
    }

    const totalCount = messageSummaryRaw.reduce((s, r) => s + (r.count ?? 0), 0);

    return {
      schemaVersion: '1',
      exportedAt: new Date().toISOString(),
      notice:
        'Message content is end-to-end encrypted and cannot be provided server-side. ' +
        'This export contains only the metadata the server holds.',
      profile: {
        id: profile.id,
        tenantId: profile.tenantId,
        argusId: profile.argusId,
        displayName: profile.displayName ?? null,
        avatarSeed: profile.avatarSeed ?? null,
        role: profile.role,
        status: profile.status,
        createdAt: profile.createdAt.toISOString(),
      },
      devices: devices.map((d) => ({
        id: d.id,
        createdAt: d.createdAt.toISOString(),
      })),
      conversations: conversations.map((c) => ({
        id: c.id,
        createdAt: c.createdAt.toISOString(),
      })),
      messageSummary: {
        totalCount,
        byConversation: messageSummaryRaw
          .filter((r) => r.firstAt && r.lastAt)
          .map((r) => ({
            conversationId: r.conversationId,
            count: r.count ?? 0,
            firstAt: r.firstAt!.toISOString(),
            lastAt: r.lastAt!.toISOString(),
          })),
      },
      attachments: attachments.map((a) => ({
        id: a.id,
        conversationId: a.conversationId,
        objectKey: a.objectKey,
        byteSize: a.byteSize,
        createdAt: a.createdAt.toISOString(),
        expiresAt: a.expiresAt?.toISOString() ?? null,
      })),
      pushSubscriptions: pushSubs.map((p) => ({
        id: p.id,
        endpointPrefix: p.endpoint.slice(0, 40),
        createdAt: p.createdAt.toISOString(),
      })),
      auditEvents: auditEvents.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        createdAt: e.createdAt.toISOString(),
        metadata:
          (e.metadata as Record<string, string | number | boolean | string[]> | null) ?? null,
      })),
      invitesCreated: invitesCreated.map((i) => ({
        id: i.id,
        createdAt: i.createdAt.toISOString(),
        expiresAt: i.expiresAt.toISOString(),
        acceptedAt: i.acceptedAt?.toISOString() ?? null,
        revokedAt: i.revokedAt?.toISOString() ?? null,
      })),
    };
  }

  /**
   * GDPR Art. 17 — right to erasure. Cascade-deletes all rows the server holds for this user.
   *
   * Deletion order respects NO-ACTION FK constraints (welcome rows, sent messages pseudonymized,
   * invite accepted_by nulled) before the user row is deleted (which cascades devices, key
   * packages, push subscriptions, conversation memberships and receipts). Blobs are
   * deleted best-effort AFTER the DB transaction: rows are gone first so no new auth path can
   * generate a grant; the content keys lived in MLS envelopes only, never in this DB.
   *
   * NOTE: the Zitadel identity (external IdP account) is NOT deleted here — it lives outside
   * this service's trust boundary. A tenant operator must revoke it in the Zitadel admin
   * console. See docs/threat-models/gdpr.md §6 for the runbook.
   */
  async deleteAccount(auth: VerifiedAuth): Promise<void> {
    // 1. DB transaction: resolve user id, handle NO-ACTION FKs, then delete the user row.
    //    objectKeys are collected inside the same transaction (between 1d and 1e) so that
    //    attachments uploaded between a pre-transaction query and the delete are not orphaned.
    const result = await withTenant(auth.tenantId, async (tx) => {
      const user = await resolveUserId(tx, auth);
      if (!user) return null; // already deleted or never provisioned — idempotent

      // Guard: the breakglass-admin account cannot self-delete. Deleting the users row would
      // cascade to admin_credentials (FK ON DELETE RESTRICT), disabling the emergency login path
      // until the service restarts and re-provisions — a denial-of-recovery attack.
      if (user.displayName === 'breakglass-admin') {
        throw new ForbiddenException('breakglass-admin account cannot be deleted');
      }

      // 1a. Delete conversation_welcomes — direct NO-ACTION FKs on both recipient and sender.
      //     The cascade through conversation_members covers recipient_user_id in theory, but
      //     sender_user_id has no cascade path, so we delete explicitly for both.
      await tx
        .delete(schema.conversationWelcomes)
        .where(
          and(
            eq(schema.conversationWelcomes.tenantId, auth.tenantId),
            or(
              eq(schema.conversationWelcomes.recipientUserId, user.id),
              eq(schema.conversationWelcomes.senderUserId, user.id),
            ),
          ),
        );

      // 1b. Pseudonymize sent messages — NO-ACTION FK; NULL sender = "account erased".
      //     Keeps ciphertext accessible for offline recipients (they are entitled to it).
      await tx
        .update(schema.messages)
        .set({ senderUserId: sql`NULL` })
        .where(
          and(
            eq(schema.messages.tenantId, auth.tenantId),
            eq(schema.messages.senderUserId, user.id),
          ),
        );

      // 1b-bis. Pseudonymize sent commits — same pattern as messages: keep the ciphertext
      //         accessible (other members are entitled to it) but erase the sender identity.
      await tx
        .update(schema.conversationCommits)
        .set({ senderUserId: sql`NULL` })
        .where(
          and(
            eq(schema.conversationCommits.tenantId, auth.tenantId),
            eq(schema.conversationCommits.senderUserId, user.id),
          ),
        );

      // 1c. Null accepted_by on invites — nullable FK with no ON DELETE clause.
      await tx
        .update(schema.tenantInvites)
        .set({ acceptedBy: sql`NULL` })
        .where(
          and(
            eq(schema.tenantInvites.tenantId, auth.tenantId),
            eq(schema.tenantInvites.acceptedBy, user.id),
          ),
        );

      // 1d. Null conversations.created_by — NO-ACTION FK (not cascade); the conversation and
      //     all members' ciphertext must survive the creator's erasure. NULL created_by means
      //     "created by an account that was erased". Requires migration 0020 (column nullable +
      //     UPDATE grant on conversations to argus_app).
      await tx
        .update(schema.conversations)
        .set({ createdBy: sql`NULL` })
        .where(
          and(
            eq(schema.conversations.tenantId, auth.tenantId),
            eq(schema.conversations.createdBy, user.id),
          ),
        );

      // 1e+1f. Delete attachment rows and collect object keys atomically via RETURNING.
      //        A single DELETE...RETURNING is atomic — no READ COMMITTED race between
      //        a separate SELECT and DELETE where a concurrently committed row could be
      //        deleted but its key missed from the collection list.
      const deletedAttachments = await tx
        .delete(schema.attachments)
        .where(
          and(
            eq(schema.attachments.tenantId, auth.tenantId),
            eq(schema.attachments.uploadedBy, user.id),
          ),
        )
        .returning({ objectKey: schema.attachments.objectKey });
      const objectKeys = deletedAttachments.map((r) => r.objectKey);

      // 1g. Delete audit events where this identity was the actor — NO-ACTION FK (actor_sub is
      //     a string, not a UUID FK to users); rows survive user deletion otherwise. Erasing
      //     personal data from the audit log is required under GDPR Art. 17; the audit trail
      //     retains event type and tenant context for any rows created by other actors.
      //     Both Zitadel and argus subjects are erased so token-family switches don't leave orphans.
      //     Requires migration 0021 (grant delete on audit_events to argus_app).
      await tx
        .delete(schema.auditEvents)
        .where(
          and(
            eq(schema.auditEvents.tenantId, auth.tenantId),
            or(
              eq(schema.auditEvents.actorSub, user.externalIdentityId),
              eq(schema.auditEvents.actorSub, `argusid:${user.argusId}`),
            ),
          ),
        );

      // 1h. Delete the user row — cascades:
      //     • devices → key_packages (cascade), push_subscriptions (cascade)
      //     • auth_sessions (cascade) — migration 0032
      //     • conversation_members (cascade) → conversation_receipts (cascade)
      //     • tenant_invites.created_by (cascade)
      await tx
        .delete(schema.users)
        .where(and(eq(schema.users.id, user.id), eq(schema.users.tenantId, auth.tenantId)));

      return { externalId: user.externalIdentityId, argusId: user.argusId, objectKeys };
    });

    // 2. Clean up the routing index (no RLS — uses withRouting). Best-effort: if this fails
    //    the user row is already gone and the stale binding only matters if the Zitadel identity
    //    still exists (the documented external gap). Wrap so a transient DB error doesn't surface.
    if (result) {
      try {
        await withRouting(async (tx) => {
          // Delete both the Zitadel sub and the argus sub — a user who has used both token
          // families has two entries; missing either would leave a stale routing binding.
          await tx
            .delete(schema.userTenantIndex)
            .where(
              or(
                eq(schema.userTenantIndex.sub, result.externalId),
                eq(schema.userTenantIndex.sub, `argusid:${result.argusId}`),
              ),
            );
        });
      } catch (err) {
        this.logger.warn(
          `gdpr: failed to delete routing index for ${result.externalId}: ${String(err)}`,
        );
      }
    }

    // 3. Delete blobs best-effort — rows are already gone, so no auth path can generate a new
    //    download grant. Failures are logged but not surfaced: the ciphertext is useless without
    //    the content key (which lived only in MLS envelopes), and the B2 lifecycle rule reaps it
    //    within 2 days regardless.
    for (const key of result?.objectKeys ?? []) {
      try {
        await this.blobStore.deleteObject(key);
      } catch (err) {
        this.logger.warn(`gdpr: failed to delete blob ${key}: ${String(err)}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveUserId(
  tx: Tx,
  auth: VerifiedAuth,
): Promise<
  | { id: string; externalIdentityId: string; argusId: string; displayName: string | null }
  | undefined
> {
  const [row] = await tx
    .select({
      id: schema.users.id,
      externalIdentityId: schema.users.externalIdentityId,
      argusId: schema.users.argusId,
      displayName: schema.users.displayName,
    })
    .from(schema.users)
    .where(
      and(
        auth.userId
          ? eq(schema.users.id, auth.userId)
          : eq(schema.users.externalIdentityId, auth.sub),
        eq(schema.users.tenantId, auth.tenantId),
      ),
    )
    .limit(1);
  return row;
}

function buildEmptyExport(): MeExport {
  return {
    schemaVersion: '1',
    exportedAt: new Date().toISOString(),
    notice:
      'Message content is end-to-end encrypted and cannot be provided server-side. ' +
      'This export contains only the metadata the server holds.',
    profile: null,
    devices: [],
    conversations: [],
    messageSummary: { totalCount: 0, byConversation: [] },
    attachments: [],
    pushSubscriptions: [],
    auditEvents: [],
    invitesCreated: [],
  };
}
