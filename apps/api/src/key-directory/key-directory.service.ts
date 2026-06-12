import { BadRequestException, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AuditService } from '../audit/audit.service.js';
import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant } from '../db/index.js';

/** Max un-claimed KeyPackages per device — bounds pool growth until GC exists (cf. audit retention). */
const MAX_AVAILABLE_PER_DEVICE = 200;

/** Validates the raw one-time-use claim row so a schema drift on this security path fails loudly. */
const ClaimRowSchema = z.object({
  device_id: z.string().uuid(),
  key_package: z.string(),
});

/** Validates a claim-all row — includes the device's stable signature key (fetched via JOIN). */
const ClaimAllRowSchema = z.object({
  device_id: z.string().uuid(),
  key_package: z.string(),
  signature_public_key: z.string(),
});

export interface PublishResult {
  deviceId: string;
  /** Net-new KeyPackages inserted by THIS call (already-published dups are skipped). */
  published: number;
  /** Total UNCLAIMED KeyPackages for this device after the call — lets the client replenish to target
   * after others have claimed some (re-publishing claimed packages inserts nothing, so count drives it). */
  available: number;
}

export interface ClaimedKeyPackage {
  deviceId: string;
  signaturePublicKey: string;
  keyPackage: string;
}

export interface RevokeResult {
  /** Number of UNCLAIMED KeyPackages deleted for the caller's device (0 if none / no such device). */
  revoked: number;
}

@Injectable()
export class KeyDirectoryService {
  constructor(private readonly audit: AuditService) {}

  /**
   * Register (upsert) the caller's device and add a batch of its one-time-use KeyPackages.
   * Everything is bound to the VERIFIED caller — a user can only publish for their own device.
   */
  async publish(
    auth: VerifiedAuth,
    signaturePublicKey: string,
    keyPackages: string[],
  ): Promise<PublishResult> {
    return withTenant(auth.tenantId, async (tx) => {
      const [user] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.externalIdentityId, auth.sub))
        .limit(1);
      if (!user) throw new BadRequestException('user not provisioned; sign in first');

      const [device] = await tx
        .insert(schema.devices)
        .values({ tenantId: auth.tenantId, userId: user.id, signaturePublicKey })
        .onConflictDoUpdate({
          target: [
            schema.devices.tenantId,
            schema.devices.userId,
            schema.devices.signaturePublicKey,
          ],
          set: { signaturePublicKey }, // no-op update so the existing row is returned (idempotent re-register)
        })
        .returning({ id: schema.devices.id });
      if (!device) throw new Error('device upsert returned no row');

      // Lock the device row so the cap count-then-insert is atomic per device (no concurrent-publish
      // TOCTOU). The onConflictDoUpdate above already took this lock; this makes it explicit.
      await tx.execute(sql`select 1 from devices where id = ${device.id} for update`);

      const unique = [...new Set(keyPackages)]; // drop intra-batch duplicates

      // onConflictDoNothing + the (tenant, device, md5(key_package)) unique index skips any
      // already-published package (retried batch); `published` reports rows actually inserted.
      const inserted = await tx
        .insert(schema.keyPackages)
        .values(
          unique.map((kp) => ({ tenantId: auth.tenantId, deviceId: device.id, keyPackage: kp })),
        )
        .onConflictDoNothing()
        .returning({ id: schema.keyPackages.id });

      // Recount unclaimed AFTER the insert rather than trusting a pre-insert count + inserted.length:
      // claim() doesn't take this device-row lock, so a concurrent claim could have reduced the pool in
      // between. This statement sees our own just-inserted rows + any committed claims, so `available` is
      // accurate — the client trusts it to decide replenishment (an over-count would leave it short).
      const counted = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.keyPackages)
        .where(
          and(eq(schema.keyPackages.deviceId, device.id), isNull(schema.keyPackages.claimedAt)),
        );
      const available = counted[0]?.n ?? 0;

      // Cap on the true post-insert unclaimed count (so an idempotent retry near the cap isn't wrongly
      // rejected). Throwing rolls back the insert above (device row is locked for the tx).
      if (available > MAX_AVAILABLE_PER_DEVICE) {
        throw new BadRequestException(
          `too many unclaimed key packages (max ${MAX_AVAILABLE_PER_DEVICE} per device)`,
        );
      }
      return { deviceId: device.id, published: inserted.length, available };
    });
  }

  /**
   * Atomically claim the oldest AVAILABLE KeyPackage for `targetUserId` (one-time-use). Returns the
   * package + the device's signature key (so the client can verify the fingerprint). null if the pool
   * is empty — callers must NOT silently reuse; they prompt the target's client to replenish.
   */
  async claim(auth: VerifiedAuth, targetUserId: string): Promise<ClaimedKeyPackage | null> {
    const claimed = await withTenant(auth.tenantId, async (tx) => {
      // SELECT ... FOR UPDATE SKIP LOCKED inside the UPDATE makes concurrent claims pick different rows.
      const rows = (await tx.execute(sql`
        update key_packages set claimed_at = now()
        where id = (
          select kp.id
          from key_packages kp
          join devices d on d.id = kp.device_id
          where d.user_id = ${targetUserId} and kp.claimed_at is null
          order by kp.created_at asc
          limit 1
          for update skip locked
        )
        returning device_id, key_package
      `)) as unknown as unknown[];

      if (rows.length === 0) return null;
      const row = ClaimRowSchema.parse(rows[0]); // fail loudly if the raw row shape ever drifts

      const [device] = await tx
        .select({ sig: schema.devices.signaturePublicKey })
        .from(schema.devices)
        .where(eq(schema.devices.id, row.device_id))
        .limit(1);
      if (!device) return null;

      return {
        deviceId: row.device_id,
        signaturePublicKey: device.sig,
        keyPackage: row.key_package,
      };
    });

    // Audit each successful claim (separate tx) so pool-drain attempts are detectable. Per-resource
    // rate-limiting is deferred to checkpoint 46; see docs/threat-models/key-directory.md §3/§6.
    if (claimed) {
      await this.audit.record(auth.tenantId, {
        eventType: 'keydir.key_package_claimed',
        actorSub: auth.sub,
      });
    }
    return claimed;
  }

  /**
   * Revoke (delete) the caller's OWN device's UNCLAIMED KeyPackages, identified by the device's signature
   * public key. Used before re-provisioning a cleared/reset device so its now-unopenable public packages
   * can't poison peers' initiations (device-provisioning.md §6). Authz: the device is resolved by
   * (caller's user, signaturePublicKey), so a user can ONLY revoke their own device — never another user's
   * or device's packages. CLAIMED packages are left untouched (an in-flight Welcome may be sealed to one).
   */
  async revokeUnclaimed(auth: VerifiedAuth, signaturePublicKey: string): Promise<RevokeResult> {
    const revoked = await withTenant(auth.tenantId, async (tx) => {
      const [user] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.externalIdentityId, auth.sub))
        .limit(1);
      if (!user) throw new BadRequestException('user not provisioned; sign in first');

      // Resolve the caller's OWN device by its signature key (ownership authz — never another user's device;
      // the row is also tenant-scoped by RLS). No such device → nothing to revoke (no existence oracle).
      const [device] = await tx
        .select({ id: schema.devices.id })
        .from(schema.devices)
        .where(
          and(
            eq(schema.devices.userId, user.id),
            eq(schema.devices.signaturePublicKey, signaturePublicKey),
          ),
        )
        .limit(1);
      if (!device) return 0;

      // Delete ONLY the unclaimed packages for this device. claimed_at IS NULL = available; a set value =
      // consumed (one-time-use), which we must keep (a recipient may still be joining via its sealed Welcome).
      const deleted = await tx
        .delete(schema.keyPackages)
        .where(
          and(eq(schema.keyPackages.deviceId, device.id), isNull(schema.keyPackages.claimedAt)),
        )
        .returning({ id: schema.keyPackages.id });
      return deleted.length;
    });

    // Audit only an effective revoke (separate tx) so it's detectable; a no-op (no device / nothing to
    // revoke) adds no audit noise. Per-resource rate-limiting rides checkpoint 46.
    if (revoked > 0) {
      await this.audit.record(auth.tenantId, {
        eventType: 'keydir.key_packages_revoked',
        actorSub: auth.sub,
      });
    }
    return { revoked };
  }

  /**
   * Claim one unclaimed KeyPackage per device for `targetUserId` (B1 group add). Used when staging
   * a membership commit that adds a multi-device user — each device needs its own Welcome sealed to
   * its own claimed KeyPackage. Returns one entry per device that has available packages; devices with
   * an empty pool are omitted (caller must check coverage and prompt for replenishment if needed).
   * `FOR UPDATE SKIP LOCKED` per device so concurrent claims pick different rows.
   */
  async claimAll(auth: VerifiedAuth, targetUserId: string): Promise<ClaimedKeyPackage[]> {
    return withTenant(auth.tenantId, async (tx) => {
      // Claim the oldest unclaimed package per device in ONE atomic scan. The UPDATE ... FROM devices
      // JOIN lets us return the signature key in the same RETURNING clause, avoiding a second transaction
      // and the O(N) per-device lookup loop. Defense-in-depth: explicit tenant_id filter on top of RLS.
      const rows = (await tx.execute(sql`
        update key_packages kp set claimed_at = now()
        from devices d
        where kp.id in (
          select distinct on (kp2.device_id) kp2.id
          from key_packages kp2
          join devices d2 on d2.id = kp2.device_id
          where d2.user_id = ${targetUserId}
            and d2.tenant_id = ${auth.tenantId}
            and kp2.claimed_at is null
          order by kp2.device_id, kp2.created_at asc
          for update skip locked
        ) and d.id = kp.device_id
        returning kp.device_id, kp.key_package, d.signature_public_key
      `)) as unknown as unknown[];

      return rows.map((r) => {
        const parsed = ClaimAllRowSchema.parse(r);
        return {
          deviceId: parsed.device_id,
          signaturePublicKey: parsed.signature_public_key,
          keyPackage: parsed.key_package,
        };
      });
    });
  }
}
