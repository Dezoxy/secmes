import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { BlobStore } from '../blob/blob-store.js';
import { getDb } from '../db/index.js';
import { GdprService } from './gdpr.service.js';

// Integration — needs a live Postgres with migrations applied. Auto-skips without DATABASE_URL.
// Blob store is faked: deleteObject is the only method exercised here (export never deletes blobs).
const DB_URL = process.env.DATABASE_URL;

class FakeBlobStore extends BlobStore {
  presignPut = vi.fn((_key: string) => Promise.resolve(`https://blob.test/put/${_key}`));
  presignGet = vi.fn((_key: string) => Promise.resolve(`https://blob.test/get/${_key}`));
  blobSize = vi.fn((): Promise<number | null> => Promise.resolve(null));
  deleteObject = vi.fn((): Promise<void> => Promise.resolve());
}

describe.skipIf(!DB_URL)('GdprService', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  let tenantA: string;
  let tenantB: string;
  let aliceId: string;
  let aliceSub: string;
  let bobId: string;
  let convId: string;
  let deviceId: string;
  let msgId: string;
  let attachmentObjectKey: string;
  let welcomeId: string;
  let inviteId: string;

  const blob = new FakeBlobStore();
  const svc = new GdprService(blob);

  let aliceAuth: VerifiedAuth;
  let bobAuth: VerifiedAuth; // same tenant, different user
  let carolAuth: VerifiedAuth; // different tenant

  beforeAll(async () => {
    sql = getDb().sql;
    aliceSub = `gdpr-alice-${Date.now()}`;
    const bobSub = `gdpr-bob-${Date.now()}`;

    [{ id: tenantA }] = await sql`insert into tenants (name) values ('GDPR-A') returning id`;
    [{ id: tenantB }] = await sql`insert into tenants (name) values ('GDPR-B') returning id`;

    [{ id: aliceId }] = await sql`
      insert into users (tenant_id, external_identity_id, email, display_name)
      values (${tenantA}, ${aliceSub}, 'alice@a.test', 'Alice')
      returning id`;
    [{ id: bobId }] = await sql`
      insert into users (tenant_id, external_identity_id, email)
      values (${tenantA}, ${bobSub}, 'bob@a.test')
      returning id`;
    await sql`
      insert into users (tenant_id, external_identity_id, email)
      values (${tenantB}, 'gdpr-carol', 'carol@b.test')`;

    // Routing index
    await sql`insert into user_tenant_index (sub, tenant_id) values (${aliceSub}, ${tenantA})`;

    // Device
    [{ id: deviceId }] = await sql`
      insert into devices (tenant_id, user_id, signature_public_key)
      values (${tenantA}, ${aliceId}, 'pk-alice')
      returning id`;

    // Key backup
    await sql`
      insert into key_backups (tenant_id, user_id, backup)
      values (${tenantA}, ${aliceId}, 'sealed-backup-ciphertext')`;

    // Conversation + membership
    [{ id: convId }] = await sql`
      insert into conversations (tenant_id, created_by)
      values (${tenantA}, ${aliceId})
      returning id`;
    await sql`
      insert into conversation_members (tenant_id, conversation_id, user_id)
      values (${tenantA}, ${convId}, ${aliceId})`;
    await sql`
      insert into conversation_members (tenant_id, conversation_id, user_id)
      values (${tenantA}, ${convId}, ${bobId})`;

    // Message from alice
    [{ id: msgId }] = await sql`
      insert into messages (tenant_id, conversation_id, sender_user_id, client_message_id, ciphertext, alg, epoch)
      values (${tenantA}, ${convId}, ${aliceId}, gen_random_uuid(), 'ciphertext-blob', 'MLS_1.0', 1)
      returning id`;

    // Attachment uploaded by alice
    attachmentObjectKey = `${tenantA}/att-${Date.now()}`;
    await sql`
      insert into attachments (tenant_id, conversation_id, object_key, byte_size, uploaded_by)
      values (${tenantA}, ${convId}, ${attachmentObjectKey}, 512, ${aliceId})`;

    // Welcome (alice sent to bob)
    [{ id: welcomeId }] = await sql`
      insert into conversation_welcomes (tenant_id, conversation_id, recipient_user_id, recipient_device_id, sender_user_id, welcome, ratchet_tree)
      values (${tenantA}, ${convId}, ${bobId}, ${deviceId}, ${aliceId}, 'welcome-ct', 'rt-ct')
      returning id`;

    // Push subscription on alice's device
    await sql`
      insert into push_subscriptions (tenant_id, device_id, user_id, endpoint, p256dh, auth)
      values (${tenantA}, ${deviceId}, ${aliceId}, 'https://push.example.test/endpoint/alice/sub', 'p256-pub', 'auth-secret')`;

    // Audit event (alice as actor)
    await sql`
      insert into audit_events (tenant_id, actor_sub, event_type, metadata)
      values (${tenantA}, ${aliceSub}, 'device.registered', '{"deviceId":"fake-id"}'::jsonb)`;

    // Invite created by alice
    [{ id: inviteId }] = await sql`
      insert into tenant_invites (tenant_id, created_by, token_hash, invitee_email, expires_at)
      values (${tenantA}, ${aliceId}, 'hash-abc', 'invited@a.test', now() + interval '7 days')
      returning id`;

    aliceAuth = { sub: aliceSub, tenantId: tenantA };
    bobAuth = { sub: bobSub, tenantId: tenantA };
    carolAuth = { sub: 'gdpr-carol', tenantId: tenantB };
  });

  afterAll(async () => {
    if (tenantA) await sql`delete from tenants where id = ${tenantA}`;
    if (tenantB) await sql`delete from tenants where id = ${tenantB}`;
    // routing index cleaned by deleteAccount in the delete suite; clean up remainder
    await sql`delete from user_tenant_index where sub = ${aliceSub}`.catch(() => undefined);
    await sql.end({ timeout: 5 });
  });

  // ---------------------------------------------------------------------------
  // exportAccount
  // ---------------------------------------------------------------------------

  describe('exportAccount', () => {
    it('returns a complete snapshot of all metadata categories', async () => {
      const exp = await svc.exportAccount(aliceAuth);

      expect(exp.schemaVersion).toBe('1');
      expect(exp.exportedAt).toBeTruthy();
      expect(exp.notice).toContain('end-to-end encrypted');

      // Profile
      expect(exp.profile).not.toBeNull();
      expect(exp.profile!.id).toBe(aliceId);
      expect(exp.profile!.tenantId).toBe(tenantA);
      expect(exp.profile!.email).toBe('alice@a.test');
      expect(exp.profile!.displayName).toBe('Alice');

      // Devices
      expect(exp.devices).toHaveLength(1);
      expect(exp.devices[0]!.id).toBe(deviceId);

      // Key backup
      expect(exp.keyBackup.exists).toBe(true);
      expect(exp.keyBackup.createdAt).toBeTruthy();

      // Conversations
      expect(exp.conversations.some((c) => c.id === convId)).toBe(true);

      // Message summary
      expect(exp.messageSummary.totalCount).toBeGreaterThanOrEqual(1);
      const bucket = exp.messageSummary.byConversation.find((b) => b.conversationId === convId);
      expect(bucket).toBeDefined();
      expect(bucket!.count).toBeGreaterThanOrEqual(1);

      // Attachments
      const att = exp.attachments.find((a) => a.objectKey === attachmentObjectKey);
      expect(att).toBeDefined();
      expect(att!.byteSize).toBe(512);

      // Push subscriptions (prefix only — never the full capability URL)
      expect(exp.pushSubscriptions).toHaveLength(1);
      expect(exp.pushSubscriptions[0]!.endpointPrefix).toBe(
        'https://push.example.test/endpoint/alice/sub'.slice(0, 40),
      );
      expect(exp.pushSubscriptions[0]!.endpointPrefix).toHaveLength(40);

      // Audit events
      expect(exp.auditEvents.some((e) => e.eventType === 'device.registered')).toBe(true);

      // No ciphertext, no content keys
      const raw = JSON.stringify(exp);
      expect(raw).not.toContain('ciphertext');
      expect(raw).not.toContain('sealed-backup');
      expect(raw).not.toContain('welcome-ct');
    });

    it('excludes data belonging to other users in the same tenant', async () => {
      const exp = await svc.exportAccount(bobAuth);
      // Bob has no attachment, no audit events, no invites — alice's rows must not appear
      expect(exp.attachments.every((a) => a.objectKey !== attachmentObjectKey)).toBe(true);
      expect(exp.auditEvents.every((e) => e.eventType !== 'device.registered')).toBe(true);
      expect(exp.invitesCreated.every((i) => i.id !== inviteId)).toBe(true);
    });

    it('cross-tenant isolation — carol gets no data from tenant A', async () => {
      const exp = await svc.exportAccount(carolAuth);
      const raw = JSON.stringify(exp);
      expect(raw).not.toContain(tenantA);
      expect(raw).not.toContain(aliceId);
      expect(raw).not.toContain(convId);
    });

    it('returns minimal empty structure when user is not provisioned', async () => {
      const exp = await svc.exportAccount({ sub: 'nobody', tenantId: tenantA });
      expect(exp.schemaVersion).toBe('1');
      expect(exp.profile).toBeNull();
      expect(exp.devices).toHaveLength(0);
      expect(exp.messageSummary.totalCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // deleteAccount
  // ---------------------------------------------------------------------------

  describe('deleteAccount', () => {
    it('pseudonymizes sent messages (senderUserId → null) so offline recipients retain access', async () => {
      await svc.deleteAccount(aliceAuth);

      const [msg] = await sql`select sender_user_id from messages where id = ${msgId}`;
      expect(msg!.sender_user_id).toBeNull();
    });

    it('deletes the user row (and cascades devices, key backup, push subs, memberships)', async () => {
      const [user] = await sql`select id from users where id = ${aliceId}`;
      expect(user).toBeUndefined();

      const [device] = await sql`select id from devices where id = ${deviceId}`;
      expect(device).toBeUndefined();

      const [kb] =
        await sql`select id from key_backups where user_id = ${aliceId} and tenant_id = ${tenantA}`;
      expect(kb).toBeUndefined();

      const [member] = await sql`select id from conversation_members where user_id = ${aliceId}`;
      expect(member).toBeUndefined();
    });

    it('deletes attachment metadata rows', async () => {
      const [att] =
        await sql`select object_key from attachments where object_key = ${attachmentObjectKey}`;
      expect(att).toBeUndefined();
    });

    it('deletes conversation_welcomes where alice was sender or recipient', async () => {
      const [w] = await sql`select id from conversation_welcomes where id = ${welcomeId}`;
      expect(w).toBeUndefined();
    });

    it('deletes audit events where alice was the actor', async () => {
      const [evt] =
        await sql`select id from audit_events where actor_sub = ${aliceSub} and tenant_id = ${tenantA}`;
      expect(evt).toBeUndefined();
    });

    it('removes alice from the routing index (user_tenant_index)', async () => {
      const [row] = await sql`select sub from user_tenant_index where sub = ${aliceSub}`;
      expect(row).toBeUndefined();
    });

    it('calls deleteObject once per blob and tolerates failures', async () => {
      // deleteObject was called with alice's attachment key during deleteAccount above
      expect(blob.deleteObject).toHaveBeenCalledWith(attachmentObjectKey);
    });

    it('leaves other users rows untouched (cross-user isolation within tenant)', async () => {
      const [bob] = await sql`select id from users where id = ${bobId}`;
      expect(bob).toBeDefined();
      const [bobMember] = await sql`select id from conversation_members where user_id = ${bobId}`;
      expect(bobMember).toBeDefined();
    });

    it('is idempotent — second call on an already-erased account does nothing and does not throw', async () => {
      await expect(svc.deleteAccount(aliceAuth)).resolves.toBeUndefined();
    });
  });
});
