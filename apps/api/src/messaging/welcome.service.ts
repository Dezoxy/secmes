import { verifyWelcomeConsume, verifyWelcomeFetch } from '@argus/crypto/device-proof';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant, type Tx } from '../db/index.js';
import { requireMembership, requireUser } from './membership.js';
import type { RealtimeBus } from '../realtime/realtime-bus.js';
import type { DeliverWelcome } from './messaging.schemas.js';
import type { PendingWelcome, WelcomeMaterial } from './messaging.types.js';

// MLS Welcome delivery + device-proof-gated fetch/consume. One of four internal collaborators the
// MessagingService façade composes (see messaging.service.ts); constructed by the façade, not a DI provider.
export class WelcomeService {
  constructor(private readonly bus: RealtimeBus) {}

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
    const { welcomeId, recipientSubs } = await withTenant(auth.tenantId, async (tx) => {
      const sender = await requireUser(tx, auth);
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

      // Resolve the recipient's subs for the post-commit realtime nudge. Both the Zitadel sub
      // (externalIdentityId) and the argus sub (argusid:<argus_id>) are collected so sockets
      // authenticated under either token family receive the nudge.
      const [recipient] = await tx
        .select({ sub: schema.users.externalIdentityId, argusId: schema.users.argusId })
        .from(schema.users)
        .where(
          and(eq(schema.users.tenantId, auth.tenantId), eq(schema.users.id, body.recipientUserId)),
        )
        .limit(1);
      return {
        welcomeId: welcome.id,
        recipientSubs: recipient ? [recipient.sub, `argusid:${recipient.argusId}`] : [],
      };
    });

    // Post-commit (same pattern as sendMessage): the Welcome row is durable BEFORE any client is nudged,
    // so a recipient that reacts immediately always finds it. Content-free: ids + the recipient subject
    // only. Best-effort — join-on-connect remains the fallback if the recipient is offline.
    for (const recipientSub of recipientSubs) {
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
      const me = await requireUser(tx, auth);
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
      const me = await requireUser(tx, auth);
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
      const me = await requireUser(tx, auth);
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
}
