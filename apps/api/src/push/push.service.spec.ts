import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import webpush from 'web-push';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { getDb } from '../db/index.js';
import type { VapidConfig } from './push-config.js';
import { PushService } from './push.service.js';

// Integration — needs a live Postgres with migrations applied. Auto-skips without DATABASE_URL.
const DB_URL = process.env.DATABASE_URL;

// A real-format VAPID keypair generated per run, so web-push's setVapidDetails() validation passes
// when a test flips configured:true. Never a committed/CI key — actual sends are always mocked.
const vapidKeys = webpush.generateVAPIDKeys();

const configuredVapid: VapidConfig = {
  publicKey: vapidKeys.publicKey,
  privateKey: vapidKeys.privateKey,
  subject: 'mailto:test@argus.local',
  configured: false, // keep actual sends disabled in tests; we spy on webpush directly
};

describe.skipIf(!DB_URL)('PushService', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  let tenantId: string;
  let userId: string;
  let deviceId: string;
  let aliceAuth: VerifiedAuth;

  const svc = new PushService(configuredVapid);

  const fakeSub = (tag = 'a') => ({
    endpoint: `https://push.example.com/sub-${tag}`,
    p256dh: 'AAAA',
    auth: 'BBBB',
  });

  beforeAll(async () => {
    sql = getDb().sql;
    [{ id: tenantId }] = await sql`insert into tenants (name) values ('PS-test') returning id`;
    [{ id: userId }] = await sql`insert into users (tenant_id, external_identity_id, email)
                values (${tenantId}, 'ps-alice', 'alice@ps.test') returning id`;
    [{ id: deviceId }] = await sql`insert into devices (tenant_id, user_id, signature_public_key)
                values (${tenantId}, ${userId}, 'cGFk') returning id`;
    aliceAuth = { sub: 'ps-alice', tenantId };
  });

  afterAll(async () => {
    if (sql) {
      await sql`delete from tenants where id = ${tenantId}`;
      await sql.end({ timeout: 5 });
    }
  });

  // ─── upsert ────────────────────────────────────────────────────────────────

  it('upsert: stores a new push subscription', async () => {
    await svc.upsert(aliceAuth, { deviceId, subscription: fakeSub('store') });

    const [row] = await sql`
      select user_id, endpoint from push_subscriptions
      where tenant_id = ${tenantId} and device_id = ${deviceId}`;
    expect(row?.user_id).toBe(userId);
    expect(row?.endpoint).toBe('https://push.example.com/sub-store');
  });

  it('upsert: conflict (same device) updates the subscription', async () => {
    await svc.upsert(aliceAuth, { deviceId, subscription: fakeSub('v2') });

    const rows =
      await sql`select endpoint from push_subscriptions where tenant_id = ${tenantId} and device_id = ${deviceId}`;
    expect(rows).toHaveLength(1); // still one row
    expect(rows[0]?.endpoint).toBe('https://push.example.com/sub-v2');
  });

  it('upsert: rejects a non-HTTPS endpoint with TypeError', async () => {
    await expect(
      svc.upsert(aliceAuth, {
        deviceId,
        subscription: { endpoint: 'http://push.example.com/bad', p256dh: 'A', auth: 'B' },
      }),
    ).rejects.toThrow(TypeError);
  });

  it('upsert: rejects a private-IP endpoint with TypeError', async () => {
    await expect(
      svc.upsert(aliceAuth, {
        deviceId,
        subscription: { endpoint: 'https://192.168.1.1/push', p256dh: 'A', auth: 'B' },
      }),
    ).rejects.toThrow(TypeError);
  });

  it('upsert: rejects IPv6 loopback (bracket notation) with TypeError', async () => {
    await expect(
      svc.upsert(aliceAuth, {
        deviceId,
        subscription: { endpoint: 'https://[::1]/push', p256dh: 'A', auth: 'B' },
      }),
    ).rejects.toThrow(TypeError);
  });

  it('upsert: rejects IPv6 ULA (bracket notation) with TypeError', async () => {
    await expect(
      svc.upsert(aliceAuth, {
        deviceId,
        subscription: { endpoint: 'https://[fd12:3456::1]/push', p256dh: 'A', auth: 'B' },
      }),
    ).rejects.toThrow(TypeError);
  });

  it('upsert: rejects a device that belongs to another user (silent no-op, not an error)', async () => {
    // Create a different user + device in the same tenant
    const otherId = (
      (
        await sql`insert into users (tenant_id, external_identity_id, email)
                values (${tenantId}, 'ps-bob', 'bob@ps.test') returning id`
      )[0] as { id: string }
    ).id;
    const otherDeviceId = (
      (
        await sql`insert into devices (tenant_id, user_id, signature_public_key)
                values (${tenantId}, ${otherId}, 'b0Jv') returning id`
      )[0] as { id: string }
    ).id;

    // Alice tries to register Bob's device — should silently no-op (no error, no row)
    await svc.upsert(aliceAuth, { deviceId: otherDeviceId, subscription: fakeSub('hijack') });

    const rows =
      await sql`select id from push_subscriptions where tenant_id = ${tenantId} and device_id = ${otherDeviceId}`;
    expect(rows).toHaveLength(0);

    // cleanup
    await sql`delete from devices where id = ${otherDeviceId}`;
    await sql`delete from users where id = ${otherId}`;
  });

  // ─── remove ────────────────────────────────────────────────────────────────

  it('remove: deletes the subscription for the calling device only', async () => {
    // Ensure there's something to delete (upserted above in the upsert tests)
    const rowsBefore =
      await sql`select id from push_subscriptions where tenant_id = ${tenantId} and device_id = ${deviceId}`;
    expect(rowsBefore.length).toBeGreaterThan(0);

    await svc.remove(aliceAuth, deviceId);

    const rowsAfter =
      await sql`select id from push_subscriptions where tenant_id = ${tenantId} and device_id = ${deviceId}`;
    expect(rowsAfter).toHaveLength(0);
  });

  it('remove: does not affect subscriptions on other devices owned by the same user', async () => {
    // Set up two devices for Alice, each with a subscription.
    const deviceA = (
      (
        await sql`insert into devices (tenant_id, user_id, signature_public_key)
                values (${tenantId}, ${userId}, 'd2Ex') returning id`
      )[0] as { id: string }
    ).id;
    const deviceB = (
      (
        await sql`insert into devices (tenant_id, user_id, signature_public_key)
                values (${tenantId}, ${userId}, 'd2Ey') returning id`
      )[0] as { id: string }
    ).id;

    await svc.upsert(aliceAuth, { deviceId: deviceA, subscription: fakeSub('dev-a') });
    await svc.upsert(aliceAuth, { deviceId: deviceB, subscription: fakeSub('dev-b') });

    // Remove only device A's subscription.
    await svc.remove(aliceAuth, deviceA);

    const rowsA = await sql`select id from push_subscriptions where device_id = ${deviceA}`;
    expect(rowsA).toHaveLength(0); // removed

    const rowsB = await sql`select id from push_subscriptions where device_id = ${deviceB}`;
    expect(rowsB).toHaveLength(1); // untouched

    // cleanup
    await sql`delete from devices where id = ${deviceA}`;
    await sql`delete from devices where id = ${deviceB}`;
  });

  it('remove: is a no-op when no subscription exists', async () => {
    await expect(svc.remove(aliceAuth, deviceId)).resolves.toBeUndefined();
  });

  // ─── cascade ───────────────────────────────────────────────────────────────

  it('cascade: deleting the device removes its push subscription', async () => {
    // Fresh device for this test
    const cascadeDeviceId = (
      (
        await sql`insert into devices (tenant_id, user_id, signature_public_key)
                values (${tenantId}, ${userId}, 'Y2Fz') returning id`
      )[0] as { id: string }
    ).id;

    await svc.upsert(aliceAuth, { deviceId: cascadeDeviceId, subscription: fakeSub('cascade') });
    const rowsBefore =
      await sql`select id from push_subscriptions where device_id = ${cascadeDeviceId}`;
    expect(rowsBefore).toHaveLength(1);

    await sql`delete from devices where id = ${cascadeDeviceId}`;

    const rowsAfter =
      await sql`select id from push_subscriptions where device_id = ${cascadeDeviceId}`;
    expect(rowsAfter).toHaveLength(0);
  });

  // ─── notifyConversationMembers ──────────────────────────────────────────────

  it('notifyConversationMembers: no-op when not configured', async () => {
    // svc has configured=false so it returns early; no webpush call
    const webpush = await import('web-push');
    const spy = vi.spyOn(webpush.default, 'sendNotification');
    await svc.notifyConversationMembers(tenantId, 'does-not-matter', 'ps-alice');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('notifyConversationMembers: 410 removes the stale subscription row', async () => {
    // Use a service instance with configured=true so the fan-out path runs
    const configuredSvc = new PushService({ ...configuredVapid, configured: true });

    // Set up VAPID details with fake keys (sendNotification will be mocked)
    const webpush = await import('web-push');
    vi.spyOn(webpush.default, 'setVapidDetails').mockReturnValue(undefined);
    const sendSpy = vi
      .spyOn(webpush.default, 'sendNotification')
      .mockRejectedValue(Object.assign(new Error('Gone'), { statusCode: 410 }));

    // Create a second user + device + subscription + conversation membership
    const bobId2 = (
      (
        await sql`insert into users (tenant_id, external_identity_id, email)
                values (${tenantId}, 'ps-bob2', 'bob2@ps.test') returning id`
      )[0] as { id: string }
    ).id;
    const bobDeviceId2 = (
      (
        await sql`insert into devices (tenant_id, user_id, signature_public_key)
                values (${tenantId}, ${bobId2}, 'Ym9i') returning id`
      )[0] as { id: string }
    ).id;
    const convId = (
      (
        await sql`insert into conversations (tenant_id, created_by) values (${tenantId}, ${userId}) returning id`
      )[0] as { id: string }
    ).id;
    await sql`insert into conversation_members (tenant_id, conversation_id, user_id) values
              (${tenantId}, ${convId}, ${userId}),
              (${tenantId}, ${convId}, ${bobId2})`;

    // Re-upsert Alice's subscription, add Bob2's subscription
    await svc.upsert(aliceAuth, { deviceId, subscription: fakeSub('notify-alice') });
    // Bob2 subscription inserted directly (svc.upsert checks ownership, need bobAuth)
    await sql`insert into push_subscriptions (tenant_id, device_id, user_id, endpoint, p256dh, auth)
              values (${tenantId}, ${bobDeviceId2}, ${bobId2},
                      'https://push.example.com/bob2', 'AAAA', 'BBBB')
              on conflict (tenant_id, device_id) do nothing`;

    const subBefore =
      await sql`select id from push_subscriptions where device_id = ${bobDeviceId2}`;
    expect(subBefore).toHaveLength(1);

    // notifyConversationMembers: sender=Alice, recipient=Bob2 → Bob2's sub gets 410 → deleted
    await configuredSvc.notifyConversationMembers(tenantId, convId, 'ps-alice');
    expect(sendSpy).toHaveBeenCalled();

    const subAfter = await sql`select id from push_subscriptions where device_id = ${bobDeviceId2}`;
    expect(subAfter).toHaveLength(0); // self-healed

    sendSpy.mockRestore();

    // cleanup
    await sql`delete from conversations where id = ${convId}`;
    await sql`delete from devices where id = ${bobDeviceId2}`;
    await sql`delete from users where id = ${bobId2}`;
  });
});
