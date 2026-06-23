import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import webpush from 'web-push';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant } from '../db/index.js';
import type { PushSubscription, SubscribePushRequest } from './push.schemas.js';
import type { VapidConfig } from './push-config.js';

export const VAPID_CONFIG = 'VAPID_CONFIG';

// Private ranges to block as push endpoints (SSRF guard). The check runs on the PARSED hostname
// before any DB write, so a redirected URL can't bypass it at the HTTP layer.
// ::ffff: covers IPv4-mapped IPv6 (::ffff:127.0.0.1, ::ffff:192.168.x.x, etc.) which the URL
// parser normalises to this form — a legitimate push endpoint never uses IPv4-mapped addresses.
// fc[0-9a-f] / fd[0-9a-f] anchors the ULA IPv6 check to actual hex digits so fc.example.com
// (a valid public hostname) is not rejected.
const PRIVATE_IP_RE =
  /^(127\.|169\.254\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|::ffff:|fc[0-9a-f]|fd[0-9a-f]|fe80)/i;

/** Validate an endpoint before storing. Throws a TypeError (caught in controller → 400) on failure. */
function assertSafeEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TypeError('endpoint is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new TypeError('endpoint must be https');
  // Strip IPv6 bracket notation: URL.hostname returns "[::1]" not "::1" for IPv6 literals.
  const host = url.hostname.replace(/^\[(.+)\]$/, '$1');
  if (host === 'localhost' || host === '0.0.0.0' || PRIVATE_IP_RE.test(host)) {
    throw new TypeError('endpoint targets a private or reserved address');
  }
}

@Injectable()
export class PushService {
  private readonly configured: boolean;

  constructor(
    @InjectPinoLogger(PushService.name) private readonly logger: PinoLogger,
    @Inject(VAPID_CONFIG) private readonly vapid: VapidConfig,
  ) {
    this.configured = vapid.configured;
    if (vapid.configured) {
      webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    }
  }

  /**
   * Upsert the caller's push subscription for a specific device. AUTHZ: the device must belong to the
   * verified caller — prevents one tenant member from registering a subscription on another's device
   * (which would let them observe when that device receives a push). Any other error is a 400.
   */
  async upsert(auth: VerifiedAuth, body: SubscribePushRequest): Promise<void> {
    assertSafeEndpoint(body.subscription.endpoint);

    await withTenant(auth.tenantId, async (tx) => {
      // Resolve the caller's argus user id.
      const [user] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(
          auth.userId
            ? eq(schema.users.id, auth.userId)
            : eq(schema.users.externalIdentityId, auth.sub),
        )
        .limit(1);
      if (!user) return; // user not provisioned; silent no-op (PUT is idempotent)

      // Verify that deviceId belongs to the verified caller — not just to the tenant.
      const [device] = await tx
        .select({ userId: schema.devices.userId })
        .from(schema.devices)
        .where(
          and(eq(schema.devices.tenantId, auth.tenantId), eq(schema.devices.id, body.deviceId)),
        )
        .limit(1);
      if (!device || device.userId !== user.id) return; // foreign device — silent no-op

      await tx
        .insert(schema.pushSubscriptions)
        .values({
          tenantId: auth.tenantId,
          deviceId: body.deviceId,
          userId: user.id,
          endpoint: body.subscription.endpoint,
          p256dh: body.subscription.p256dh,
          auth: body.subscription.auth,
        })
        .onConflictDoUpdate({
          target: [schema.pushSubscriptions.tenantId, schema.pushSubscriptions.deviceId],
          set: {
            endpoint: body.subscription.endpoint,
            p256dh: body.subscription.p256dh,
            auth: body.subscription.auth,
            updatedAt: sql`now()`,
          },
        });
    });
  }

  /**
   * Remove the verified caller's push subscription for a specific device. Silent no-op if none
   * exists. Scoped to (tenantId, userId, deviceId) so disabling push on one device never affects
   * other devices belonging to the same user.
   */
  async remove(auth: VerifiedAuth, deviceId: string): Promise<void> {
    await withTenant(auth.tenantId, async (tx) => {
      const [user] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(
          auth.userId
            ? eq(schema.users.id, auth.userId)
            : eq(schema.users.externalIdentityId, auth.sub),
        )
        .limit(1);
      if (!user) return;

      await tx
        .delete(schema.pushSubscriptions)
        .where(
          and(
            eq(schema.pushSubscriptions.tenantId, auth.tenantId),
            eq(schema.pushSubscriptions.userId, user.id),
            eq(schema.pushSubscriptions.deviceId, deviceId),
          ),
        );
    });
  }

  /**
   * Fan a content-free ping to every conversation member who has a push subscription, excluding the
   * sender. Best-effort: ALL errors are caught so a push failure never surfaces to the caller or delays
   * the HTTP response. A 410 from the push service means the subscription is stale — self-heal by
   * deleting the row. Called POST-COMMIT from MessagingService.
   * No-op when VAPID is not configured.
   */
  async notifyConversationMembers(
    tenantId: string,
    conversationId: string,
    senderSub: string,
    senderUserId?: string,
  ): Promise<void> {
    if (!this.configured) return;

    try {
      await withTenant(tenantId, async (tx) => {
        // Resolve the sender's internal user id for the exclusion filter.
        // senderUserId (uid JWT claim) is preferred for argus-minted tokens;
        // fall back to externalIdentityId for Zitadel tokens.
        const [sender] = await tx
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(
            senderUserId
              ? eq(schema.users.id, senderUserId)
              : eq(schema.users.externalIdentityId, senderSub),
          )
          .limit(1);
        if (!sender) return;

        // Collect member user ids for this conversation, excluding the sender.
        const memberRows = await tx
          .select({ userId: schema.conversationMembers.userId })
          .from(schema.conversationMembers)
          .where(
            and(
              eq(schema.conversationMembers.tenantId, tenantId),
              eq(schema.conversationMembers.conversationId, conversationId),
              ne(schema.conversationMembers.userId, sender.id),
            ),
          );
        if (memberRows.length === 0) return;

        const memberIds = memberRows.map((r) => r.userId);

        // Fetch push subscriptions for those members.
        const subs = await tx
          .select({
            id: schema.pushSubscriptions.id,
            endpoint: schema.pushSubscriptions.endpoint,
            p256dh: schema.pushSubscriptions.p256dh,
            auth: schema.pushSubscriptions.auth,
          })
          .from(schema.pushSubscriptions)
          .where(
            and(
              eq(schema.pushSubscriptions.tenantId, tenantId),
              inArray(schema.pushSubscriptions.userId, memberIds),
            ),
          );

        const staleIds = await this.sendPayload(subs, JSON.stringify({ type: 'new_message' }));

        if (staleIds.length > 0) {
          await tx
            .delete(schema.pushSubscriptions)
            .where(inArray(schema.pushSubscriptions.id, staleIds));
        }
      });
    } catch (err: unknown) {
      // DB or config errors must never surface to the message-send caller.
      this.logger.warn(
        `push: fan-out error for conversation ${conversationId}: ${(err as Error).name}`,
      );
    }
  }

  /**
   * Fan a content-free typed ping to every push subscription belonging to a single user.
   * Best-effort: all errors swallowed, stale 410/404 subscriptions self-healed. No-op when
   * VAPID is not configured.
   */
  async notifyUser(tenantId: string, recipientUserId: string, type: string): Promise<void> {
    if (!this.configured) return;
    try {
      await withTenant(tenantId, async (tx) => {
        const subs = await tx
          .select({
            id: schema.pushSubscriptions.id,
            endpoint: schema.pushSubscriptions.endpoint,
            p256dh: schema.pushSubscriptions.p256dh,
            auth: schema.pushSubscriptions.auth,
          })
          .from(schema.pushSubscriptions)
          .where(
            and(
              eq(schema.pushSubscriptions.tenantId, tenantId),
              eq(schema.pushSubscriptions.userId, recipientUserId),
            ),
          );

        const staleIds = await this.sendPayload(subs, JSON.stringify({ type }));

        if (staleIds.length > 0) {
          await tx
            .delete(schema.pushSubscriptions)
            .where(inArray(schema.pushSubscriptions.id, staleIds));
        }
      });
    } catch (err: unknown) {
      this.logger.warn(
        `push: notify-user error for user ${recipientUserId}: ${(err as Error).name}`,
      );
    }
  }

  /** Send a payload to a batch of subscriptions; return ids of stale (410/404) entries. */
  private async sendPayload(
    subs: Array<{ id: string; endpoint: string; p256dh: string; auth: string }>,
    payload: string,
  ): Promise<string[]> {
    const staleIds: string[] = [];
    await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            { urgency: 'low', TTL: 3600 },
          );
        } catch (err: unknown) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 410 || status === 404) staleIds.push(sub.id);
          // Log only the row id — never endpoint, p256dh, or auth (invariant #2).
          this.logger.warn(
            `push: send failed for subscription ${sub.id}, status ${status ?? 'unknown'}`,
          );
        }
      }),
    );
    return staleIds;
  }
}

// Re-export for use in push.schemas.ts (avoids a circular dep via the controller).
export type { PushSubscription, SubscribePushRequest };
