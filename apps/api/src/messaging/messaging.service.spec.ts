import {
  generateSignatureKeypair,
  signWelcomeConsume,
  signWelcomeFetch,
} from '@argus/crypto/device-proof';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { getDb } from '../db/index.js';
import { InProcessRealtimeBus } from '../realtime/in-process-realtime-bus.js';
import { MessagingService } from './messaging.service.js';
import type { SendMessage } from './messaging.schemas.js';

// Integration (roadmap 26) — needs a live Postgres with migrations applied. Auto-skips without DATABASE_URL.
const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('MessagingService — membership authz + ciphertext-only send', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  let tenantA: string;
  let tenantB: string;
  let aliceId: string;
  let bobId: string;
  let daveId: string;
  let carolId: string;
  let daveDeviceId: string; // dave's primary device (welcomes sealed here)
  let daveDevice2Id: string; // dave's SECOND device (must not see/consume device 1's welcome)
  let bobDeviceId: string; // bob's device
  let daveDev1Priv: Uint8Array; // signature private keys, to forge proofs of possession on consume
  let daveDev2Priv: Uint8Array;
  let bobDevPriv: Uint8Array;
  const svc = new MessagingService(new InProcessRealtimeBus());

  let aliceAuth: VerifiedAuth; // tenant A, conversation creator + member
  let bobAuth: VerifiedAuth; // tenant A, member
  let daveAuth: VerifiedAuth; // tenant A, NOT a member
  let carolAuth: VerifiedAuth; // tenant B, other tenant
  let frankAuth: VerifiedAuth; // tenant A, SUSPENDED (soft-deleted)

  const msg = (over: Partial<SendMessage> = {}): SendMessage => ({
    clientMessageId: crypto.randomUUID(),
    ciphertext: 'Y2lwaGVydGV4dA==',
    alg: 'MLS_1.0',
    epoch: 0,
    ...over,
  });

  beforeAll(async () => {
    sql = getDb().sql;
    [{ id: tenantA }] = await sql`insert into tenants (name) values ('Msg-A') returning id`;
    [{ id: tenantB }] = await sql`insert into tenants (name) values ('Msg-B') returning id`;
    [{ id: aliceId }] =
      await sql`insert into users (tenant_id, external_identity_id, email) values (${tenantA}, 'm-alice', 'al@a.test') returning id`;
    [{ id: bobId }] =
      await sql`insert into users (tenant_id, external_identity_id, email) values (${tenantA}, 'm-bob', 'bob@a.test') returning id`;
    [{ id: daveId }] =
      await sql`insert into users (tenant_id, external_identity_id, email) values (${tenantA}, 'm-dave', 'dave@a.test') returning id`;
    [{ id: carolId }] =
      await sql`insert into users (tenant_id, external_identity_id, email) values (${tenantB}, 'm-carol', 'c@b.test') returning id`;
    await sql`insert into users (tenant_id, external_identity_id, email, status)
              values (${tenantA}, 'm-frank', 'frank@a.test', 'suspended')`;

    // Devices for the welcome-delivery tests (key directory #19). A welcome is sealed to ONE device, and
    // the device's Ed25519 signature key is what proves possession on consume — so use REAL keypairs and
    // store the public key the server verifies against.
    const dDev1 = generateSignatureKeypair();
    const dDev2 = generateSignatureKeypair();
    const bDev = generateSignatureKeypair();
    daveDev1Priv = dDev1.privateKey;
    daveDev2Priv = dDev2.privateKey;
    bobDevPriv = bDev.privateKey;
    [{ id: daveDeviceId }] =
      await sql`insert into devices (tenant_id, user_id, signature_public_key) values (${tenantA}, ${daveId}, ${Buffer.from(dDev1.publicKey).toString('base64')}) returning id`;
    [{ id: daveDevice2Id }] =
      await sql`insert into devices (tenant_id, user_id, signature_public_key) values (${tenantA}, ${daveId}, ${Buffer.from(dDev2.publicKey).toString('base64')}) returning id`;
    [{ id: bobDeviceId }] =
      await sql`insert into devices (tenant_id, user_id, signature_public_key) values (${tenantA}, ${bobId}, ${Buffer.from(bDev.publicKey).toString('base64')}) returning id`;

    aliceAuth = { sub: 'm-alice', tenantId: tenantA };
    bobAuth = { sub: 'm-bob', tenantId: tenantA };
    daveAuth = { sub: 'm-dave', tenantId: tenantA };
    carolAuth = { sub: 'm-carol', tenantId: tenantB };
    frankAuth = { sub: 'm-frank', tenantId: tenantA };
  });

  afterAll(async () => {
    if (sql) {
      await sql`delete from tenants where id in (${tenantA}, ${tenantB})`;
      await sql.end({ timeout: 5 });
    }
  });

  async function newConversation(): Promise<string> {
    const { conversationId } = await svc.createConversation(aliceAuth, [bobId]);
    return conversationId;
  }

  it('creates a conversation with the creator + members', async () => {
    const { conversationId } = await svc.createConversation(aliceAuth, [bobId]);
    const rows =
      await sql`select user_id from conversation_members where conversation_id = ${conversationId} order by user_id`;
    const ids = rows.map((r) => r.user_id).sort();
    expect(ids).toEqual([aliceId, bobId].sort());
  });

  it('rejects a member id from another tenant (composite FK → 400)', async () => {
    await expect(svc.createConversation(aliceAuth, [carolId])).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('a member can send; the stored row is the opaque ciphertext verbatim', async () => {
    const conv = await newConversation();
    const body = msg({ ciphertext: 'b3BhcXVl' });
    const res = await svc.sendMessage(bobAuth, conv, body);
    expect(res.deduplicated).toBe(false);
    const [row] =
      await sql`select ciphertext, sender_user_id from messages where id = ${res.messageId}`;
    expect(row?.ciphertext).toBe('b3BhcXVl'); // stored verbatim, never parsed
    expect(row?.sender_user_id).toBe(bobId); // sender is the VERIFIED caller, not client-supplied
  });

  it('a non-member (same tenant) gets 404 — no conversation-existence leak', async () => {
    const conv = await newConversation();
    await expect(svc.sendMessage(daveAuth, conv, msg())).rejects.toBeInstanceOf(NotFoundException);
  });

  it("another tenant's user cannot send into the conversation (404)", async () => {
    const conv = await newConversation();
    await expect(svc.sendMessage(carolAuth, conv, msg())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('send is idempotent on (sender, clientMessageId)', async () => {
    const conv = await newConversation();
    const body = msg();
    const first = await svc.sendMessage(bobAuth, conv, body);
    const retry = await svc.sendMessage(bobAuth, conv, body);
    expect(first.deduplicated).toBe(false);
    expect(retry.deduplicated).toBe(true);
    expect(retry.messageId).toBe(first.messageId);
    const [row] =
      await sql`select count(*)::int as n from messages where client_message_id = ${body.clientMessageId}`;
    expect((row as { n: number }).n).toBe(1);
  });

  it('emits a realtime event on a new send (after commit), but not on a dedup retry', async () => {
    const bus = new InProcessRealtimeBus();
    const spy = vi.spyOn(bus, 'emitMessageCreated');
    const svc2 = new MessagingService(bus);
    const conv = await newConversation();
    const body = msg({ ciphertext: 'ZXZlbnQ=' });

    await svc2.sendMessage(bobAuth, conv, body);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      conversationId: conv,
      message: { ciphertext: 'ZXZlbnQ=', senderUserId: bobId },
    });

    await svc2.sendMessage(bobAuth, conv, body); // idempotent retry
    expect(spy).toHaveBeenCalledTimes(1); // no re-delivery
  });

  it('idempotency is per-conversation: the same clientMessageId in two conversations both store', async () => {
    const c1 = await newConversation();
    const c2 = await newConversation();
    const cmid = crypto.randomUUID();
    const a = await svc.sendMessage(bobAuth, c1, msg({ clientMessageId: cmid }));
    const b = await svc.sendMessage(bobAuth, c2, msg({ clientMessageId: cmid }));
    expect(a.deduplicated).toBe(false);
    expect(b.deduplicated).toBe(false); // different conversation → not a dup, stored separately
    expect(a.messageId).not.toBe(b.messageId);
  });

  it('a suspended (soft-deleted) caller cannot create or send, even with a valid token', async () => {
    await expect(svc.createConversation(frankAuth, [bobId])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const conv = await newConversation();
    await expect(svc.sendMessage(frankAuth, conv, msg())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('sending to a non-existent conversation returns 404', async () => {
    await expect(svc.sendMessage(bobAuth, crypto.randomUUID(), msg())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ── fetch / list (checkpoint 27 server half) ─────────────────────────────────────────────────────
  it('a member lists messages in chronological order; ciphertext is returned verbatim', async () => {
    const conv = await newConversation();
    await svc.sendMessage(aliceAuth, conv, msg({ ciphertext: 'b3Vu' })); // 'oun'
    await svc.sendMessage(bobAuth, conv, msg({ ciphertext: 'dHdv' })); // 'two'
    const page = await svc.listMessages(bobAuth, conv, { limit: 50 });
    expect(page.messages.map((m) => m.ciphertext)).toEqual(['b3Vu', 'dHdv']); // chronological, opaque
    expect(page.messages[0]?.senderUserId).toBe(aliceId);
    expect(page.nextCursor).toBeNull(); // partial page → no more
  });

  it('keyset pagination walks the whole conversation without overlap', async () => {
    const conv = await newConversation();
    const sent: string[] = [];
    for (let i = 0; i < 5; i++) sent.push((await svc.sendMessage(bobAuth, conv, msg())).messageId);

    const p1 = await svc.listMessages(bobAuth, conv, { limit: 2 });
    expect(p1.messages.map((m) => m.id)).toEqual(sent.slice(0, 2));
    expect(p1.nextCursor).toBe(sent[1]);
    const p2 = await svc.listMessages(bobAuth, conv, { limit: 2, after: p1.nextCursor! });
    expect(p2.messages.map((m) => m.id)).toEqual(sent.slice(2, 4));
    const p3 = await svc.listMessages(bobAuth, conv, { limit: 2, after: p2.nextCursor! });
    expect(p3.messages.map((m) => m.id)).toEqual(sent.slice(4));
    expect(p3.nextCursor).toBeNull();
  });

  it('a non-member (same tenant) cannot list — 404', async () => {
    const conv = await newConversation();
    await svc.sendMessage(bobAuth, conv, msg());
    await expect(svc.listMessages(daveAuth, conv, { limit: 50 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("another tenant's user cannot list — 404", async () => {
    const conv = await newConversation();
    await svc.sendMessage(bobAuth, conv, msg());
    await expect(svc.listMessages(carolAuth, conv, { limit: 50 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('listing an empty conversation returns no messages and a null cursor', async () => {
    const conv = await newConversation();
    const page = await svc.listMessages(aliceAuth, conv, { limit: 50 });
    expect(page.messages).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  // ── catch-up sync across conversations (checkpoint 30) ───────────────────────────────────────────
  it('syncs messages across the caller’s conversations (tagged with conversationId), excluding others', async () => {
    const c1 = (await svc.createConversation(aliceAuth, [bobId])).conversationId;
    const c2 = (await svc.createConversation(aliceAuth, [bobId])).conversationId;
    const cOther = (await svc.createConversation(aliceAuth, [daveId])).conversationId; // bob NOT a member
    const m1 = (await svc.sendMessage(aliceAuth, c1, msg())).messageId;
    const m2 = (await svc.sendMessage(aliceAuth, c2, msg())).messageId;
    await svc.sendMessage(aliceAuth, cOther, msg());

    const page = await svc.syncMessages(bobAuth, { limit: 100 });
    const seen = page.messages.filter((m) => [m1, m2].includes(m.id));
    expect(seen.map((m) => m.id)).toEqual([m1, m2]); // chronological
    expect(seen.find((m) => m.id === m1)?.conversationId).toBe(c1); // tagged
    expect(seen.find((m) => m.id === m2)?.conversationId).toBe(c2);
    expect(page.messages.some((m) => m.conversationId === cOther)).toBe(false); // excluded (non-member)
  });

  it('sync paginates with the opaque nextCursor across conversations', async () => {
    const a = (await svc.createConversation(aliceAuth, [bobId])).conversationId;
    const b = (await svc.createConversation(aliceAuth, [bobId])).conversationId;
    const ids = [
      (await svc.sendMessage(aliceAuth, a, msg())).messageId,
      (await svc.sendMessage(aliceAuth, b, msg())).messageId,
      (await svc.sendMessage(aliceAuth, a, msg())).messageId,
    ];
    // Find this batch's start cursor by syncing the full stream and locating ids[0], then page from it.
    const all = await svc.syncMessages(bobAuth, { limit: 1000 });
    const startIdx = all.messages.findIndex((m) => m.id === ids[0]);
    const cursorAfterId0 = all.nextCursor; // not used directly; we walk from ids[0] below
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(cursorAfterId0 === null || typeof cursorAfterId0 === 'string').toBe(true);

    // Page through everything with limit 2 and assert ids[0..2] appear contiguously, in order.
    const collected: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const page: { messages: { id: string }[]; nextCursor: string | null } =
        await svc.syncMessages(bobAuth, { limit: 2, after: cursor });
      collected.push(...page.messages.map((m) => m.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const sub = collected.slice(collected.indexOf(ids[0]!), collected.indexOf(ids[0]!) + 3);
    expect(sub).toEqual(ids); // ids[0], ids[1], ids[2] contiguous & ordered across the paged stream
  });

  it('another tenant’s user syncs nothing from this tenant', async () => {
    const conv = await newConversation();
    await svc.sendMessage(aliceAuth, conv, msg());
    const page = await svc.syncMessages(carolAuth, { limit: 100 });
    expect(page.messages.some((m) => m.conversationId === conv)).toBe(false); // RLS: no cross-tenant
  });

  it('rejects a malformed cursor (opaque token, not a free id → no oracle)', async () => {
    await expect(
      svc.syncMessages(bobAuth, { limit: 100, after: 'not-a-cursor!' }),
    ).rejects.toThrow();
  });

  it('returns a resume cursor even on a partial final page (progress is persistable)', async () => {
    const c = (await svc.createConversation(aliceAuth, [bobId])).conversationId;
    await svc.sendMessage(aliceAuth, c, msg());
    const page = await svc.syncMessages(bobAuth, { limit: 100 }); // partial page (< 100)
    expect(page.messages.length).toBeLessThan(100);
    expect(page.nextCursor).not.toBeNull(); // resume token returned despite the page not being full

    // Resuming from it is caught up (empty); a message sent AFTER it is then returned by that cursor.
    expect(
      (await svc.syncMessages(bobAuth, { limit: 100, after: page.nextCursor! })).messages,
    ).toEqual([]);
    const next = (await svc.sendMessage(aliceAuth, c, msg())).messageId;
    const resumed = await svc.syncMessages(bobAuth, { limit: 100, after: page.nextCursor! });
    expect(resumed.messages.map((m) => m.id)).toEqual([next]);
  });

  it('preserves sync progress after the caller is removed from a conversation', async () => {
    // Bob has a cursor from conversation X, then is removed from X. He must still sync his OTHER
    // conversations — the opaque cursor carries (created_at, id), so it doesn't depend on X-membership.
    const x = (await svc.createConversation(aliceAuth, [bobId])).conversationId;
    await svc.sendMessage(aliceAuth, x, msg()); // bob's last-seen is in X
    const afterX = (await svc.syncMessages(bobAuth, { limit: 1 })).nextCursor;
    if (!afterX) throw new Error('expected a cursor');

    // Remove bob from X, then send into a DIFFERENT conversation bob is in.
    await sql`delete from conversation_members where conversation_id = ${x} and user_id = ${bobId}`;
    const y = (await svc.createConversation(aliceAuth, [bobId])).conversationId;
    const my = (await svc.sendMessage(aliceAuth, y, msg())).messageId;

    const page = await svc.syncMessages(bobAuth, { limit: 100, after: afterX });
    expect(page.messages.some((m) => m.id === my)).toBe(true); // sync still works for Y
    expect(page.messages.some((m) => m.conversationId === x)).toBe(false); // X (left) excluded
  });

  // ── delivery receipts (checkpoint 31) ────────────────────────────────────────────────────────────
  it('records a delivered + read watermark and returns it per member', async () => {
    const conv = await newConversation();
    const m1 = (await svc.sendMessage(aliceAuth, conv, msg())).messageId;
    await svc.recordReceipt(bobAuth, conv, { status: 'delivered', throughMessageId: m1 });
    await svc.recordReceipt(bobAuth, conv, { status: 'read', throughMessageId: m1 });

    const receipts = await svc.getReceipts(aliceAuth, conv);
    const bob = receipts.find((r) => r.userId === bobId);
    expect(bob?.deliveredThroughMessageId).toBe(m1);
    expect(bob?.readThroughMessageId).toBe(m1);
    expect(bob?.deliveredAt).not.toBeNull();
    expect(bob?.readAt).not.toBeNull();

    // Alice is a member but hasn't posted a receipt → still listed, with null watermarks.
    const alice = receipts.find((r) => r.userId === aliceId);
    expect(alice).toBeDefined();
    expect(alice?.deliveredThroughMessageId).toBeNull();
    expect(alice?.readAt).toBeNull();
  });

  it('advances watermarks forward only (monotonic — no rollback)', async () => {
    const conv = await newConversation();
    const m1 = (await svc.sendMessage(aliceAuth, conv, msg())).messageId;
    const m2 = (await svc.sendMessage(aliceAuth, conv, msg())).messageId;
    await svc.recordReceipt(bobAuth, conv, { status: 'read', throughMessageId: m2 });
    await svc.recordReceipt(bobAuth, conv, { status: 'read', throughMessageId: m1 }); // older → ignored

    const bob = (await svc.getReceipts(aliceAuth, conv)).find((r) => r.userId === bobId);
    expect(bob?.readThroughMessageId).toBe(m2); // stayed at the later message
  });

  it('a non-member cannot record or read receipts (404)', async () => {
    const conv = await newConversation();
    const m1 = (await svc.sendMessage(aliceAuth, conv, msg())).messageId;
    await expect(
      svc.recordReceipt(daveAuth, conv, { status: 'read', throughMessageId: m1 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.getReceipts(daveAuth, conv)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.getReceipts(carolAuth, conv)).rejects.toBeInstanceOf(NotFoundException); // cross-tenant
  });

  it('stores the watermark created_at at full microsecond precision (not ms-truncated)', async () => {
    const conv = await newConversation();
    const m1 = (await svc.sendMessage(aliceAuth, conv, msg())).messageId;
    // Force a non-zero microsecond part that a ms-only round-trip (123456 → 123) would lose.
    await sql`update messages set created_at = '2026-01-01 00:00:00.123456+00' where id = ${m1}`;
    await svc.recordReceipt(bobAuth, conv, { status: 'delivered', throughMessageId: m1 });

    const [row] = await sql`
      select to_char(delivered_through_created_at at time zone 'utc', 'US') as us
      from conversation_receipts where conversation_id = ${conv} and user_id = ${bobId}`;
    expect((row as { us: string }).us).toBe('123456'); // full µs preserved (would be 123000 if truncated)
  });

  it('rejects a receipt for a message not in the conversation', async () => {
    const conv = await newConversation();
    const other = (await svc.createConversation(aliceAuth, [bobId])).conversationId;
    const foreign = (await svc.sendMessage(aliceAuth, other, msg())).messageId; // message in a DIFFERENT conv
    await expect(
      svc.recordReceipt(bobAuth, conv, { status: 'read', throughMessageId: foreign }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ── MLS Welcome delivery (live message loop, welcome-delivery.md) ─────────────────────────────────
  const wel = (
    over: Partial<{
      recipientUserId: string;
      recipientDeviceId: string;
      welcome: string;
      ratchetTree: string;
    }> = {},
  ) => ({
    recipientUserId: daveId,
    recipientDeviceId: daveDeviceId, // a welcome is HPKE-sealed to ONE device's KeyPackage
    welcome: 'd2VsY29tZQ==', // "welcome" — opaque base64; the server never decrypts it
    ratchetTree: 'dHJlZQ==', // "tree"
    ...over,
  });

  // Proofs-of-possession of a device's signature key over (deviceId, welcomeId), base64url for the wire.
  const proofFor = (priv: Uint8Array, deviceId: string, welcomeId: string): string =>
    Buffer.from(signWelcomeConsume(priv, deviceId, welcomeId)).toString('base64url'); // CONSUME proof
  const fetchProofFor = (priv: Uint8Array, deviceId: string, welcomeId: string): string =>
    Buffer.from(signWelcomeFetch(priv, deviceId, welcomeId)).toString('base64url'); // FETCH proof

  it('deliver adds the recipient as a member and stores the opaque welcome verbatim', async () => {
    const conv = await newConversation(); // alice + bob; dave is NOT yet a member
    const { welcomeId } = await svc.deliverWelcome(aliceAuth, conv, wel());
    expect(welcomeId).toBeTruthy();

    // dave is now a member of the conversation.
    const [member] =
      await sql`select 1 as ok from conversation_members where conversation_id = ${conv} and user_id = ${daveId}`;
    expect(member?.ok).toBe(1);

    // the blobs are stored verbatim, the sender is the VERIFIED caller, and it is bound to the device.
    const [row] =
      await sql`select welcome, ratchet_tree, sender_user_id, recipient_user_id, recipient_device_id from conversation_welcomes where id = ${welcomeId}`;
    expect(row?.welcome).toBe('d2VsY29tZQ==');
    expect(row?.ratchet_tree).toBe('dHJlZQ==');
    expect(row?.sender_user_id).toBe(aliceId);
    expect(row?.recipient_user_id).toBe(daveId);
    expect(row?.recipient_device_id).toBe(daveDeviceId);
  });

  it('deliver emits a post-commit welcome nudge — ids + the recipient subject only, never the blobs', async () => {
    const bus = new InProcessRealtimeBus();
    const spy = vi.spyOn(bus, 'emitWelcomeCreated');
    const svc2 = new MessagingService(bus);
    const conv = await newConversation();
    await svc2.deliverWelcome(aliceAuth, conv, wel());
    expect(spy).toHaveBeenCalledTimes(1);
    // The recipient is matched by their VERIFIED external subject on the gateway; the event must carry
    // ids/metadata only — the sealed welcome/ratchetTree never cross the bus.
    expect(spy.mock.calls[0]?.[0]).toEqual({
      tenantId: tenantA,
      conversationId: conv,
      recipientSub: 'm-dave',
    });
  });

  it('a non-member (same tenant) cannot deliver — 404, no existence leak', async () => {
    const conv = await newConversation(); // dave is not a member
    await expect(
      svc.deliverWelcome(
        daveAuth,
        conv,
        wel({ recipientUserId: bobId, recipientDeviceId: bobDeviceId }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("another tenant's user cannot deliver — 404", async () => {
    const conv = await newConversation();
    await expect(svc.deliverWelcome(carolAuth, conv, wel())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a recipient from another tenant (composite FK → 400)', async () => {
    const conv = await newConversation();
    await expect(
      svc.deliverWelcome(aliceAuth, conv, wel({ recipientUserId: carolId })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-existent recipient (composite FK → 400)', async () => {
    const conv = await newConversation();
    await expect(
      svc.deliverWelcome(aliceAuth, conv, wel({ recipientUserId: crypto.randomUUID() })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a device that isn't the recipient's (composite FK → 400)", async () => {
    const conv = await newConversation();
    // dave is a valid recipient, but bob's device is not dave's — the (tenant, user, device) FK rejects it.
    await expect(
      svc.deliverWelcome(
        aliceAuth,
        conv,
        wel({ recipientUserId: daveId, recipientDeviceId: bobDeviceId }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('list is metadata-only; material is fetched per-welcome with a device proof, device-isolated', async () => {
    const conv = await newConversation();
    const { welcomeId: daveW } = await svc.deliverWelcome(
      aliceAuth,
      conv,
      wel({ recipientUserId: daveId, welcome: 'ZGF2ZQ==' }),
    );
    const { welcomeId: bobW } = await svc.deliverWelcome(
      aliceAuth,
      conv,
      wel({ recipientUserId: bobId, recipientDeviceId: bobDeviceId, welcome: 'Ym9i' }),
    );

    // list returns METADATA only — ids, never the blobs — and is device-isolated.
    const daves = await svc.listMyWelcomes(daveAuth, daveDeviceId);
    expect(daves.find((w) => w.id === daveW)).toBeDefined();
    expect(daves.find((w) => w.id === daveW)).not.toHaveProperty('welcome'); // no join material listed
    expect(daves.some((w) => w.id === bobW)).toBe(false); // never sees bob's welcome id
    expect((await svc.listMyWelcomes(bobAuth, bobDeviceId)).some((w) => w.id === daveW)).toBe(
      false,
    );

    // the blobs come from getWelcomeMaterial, gated by a FETCH proof; dave gets dave's blobs verbatim.
    const mat = await svc.getWelcomeMaterial(
      daveAuth,
      daveW,
      daveDeviceId,
      fetchProofFor(daveDev1Priv, daveDeviceId, daveW),
    );
    expect(mat).toEqual({ welcome: 'ZGF2ZQ==', ratchetTree: 'dHJlZQ==' });
  });

  it('getWelcomeMaterial requires a FETCH proof from the sealed-to device (no sibling / forgery / cross-op)', async () => {
    const conv = await newConversation();
    const { welcomeId } = await svc.deliverWelcome(aliceAuth, conv, wel({ welcome: 'bWF0' }));
    // device 2 fetching via its own id → wrong recipient_device → 404
    await expect(
      svc.getWelcomeMaterial(
        daveAuth,
        welcomeId,
        daveDevice2Id,
        fetchProofFor(daveDev2Priv, daveDevice2Id, welcomeId),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    // device 2 forging device 1's fetch (signs with its own key) → proof fails → 404
    await expect(
      svc.getWelcomeMaterial(
        daveAuth,
        welcomeId,
        daveDeviceId,
        fetchProofFor(daveDev2Priv, daveDeviceId, welcomeId),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    // a CONSUME proof is NOT a valid fetch proof (domain separation) → 404
    await expect(
      svc.getWelcomeMaterial(
        daveAuth,
        welcomeId,
        daveDeviceId,
        proofFor(daveDev1Priv, daveDeviceId, welcomeId),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    // device 1 with a valid FETCH proof gets the blobs
    expect(
      (
        await svc.getWelcomeMaterial(
          daveAuth,
          welcomeId,
          daveDeviceId,
          fetchProofFor(daveDev1Priv, daveDeviceId, welcomeId),
        )
      ).welcome,
    ).toBe('bWF0');
  });

  it("another tenant's user fetches no welcomes from this tenant (RLS)", async () => {
    const conv = await newConversation();
    await svc.deliverWelcome(aliceAuth, conv, wel());
    expect(await svc.listMyWelcomes(carolAuth, crypto.randomUUID())).toEqual([]); // cross-tenant: nothing
  });

  it('bounds the pending-welcome fetch by `limit` (welcome spam can’t make GET /welcomes unbounded)', async () => {
    const conv = await newConversation();
    await svc.deliverWelcome(aliceAuth, conv, wel({ welcome: 'bGltMQ==' }));
    await svc.deliverWelcome(aliceAuth, conv, wel({ welcome: 'bGltMg==' }));
    // at least these two are pending for dave's device now
    expect(await svc.listMyWelcomes(daveAuth, daveDeviceId, 1)).toHaveLength(1); // capped to the limit
    expect((await svc.listMyWelcomes(daveAuth, daveDeviceId, 100)).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('the recipient consumes their welcome with a valid proof; it is gone, and re-consume is 404', async () => {
    const conv = await newConversation();
    const { welcomeId } = await svc.deliverWelcome(aliceAuth, conv, wel({ welcome: 'b25l' }));
    expect((await svc.listMyWelcomes(daveAuth, daveDeviceId)).some((w) => w.id === welcomeId)).toBe(
      true,
    );

    await svc.consumeWelcome(
      daveAuth,
      welcomeId,
      daveDeviceId,
      proofFor(daveDev1Priv, daveDeviceId, welcomeId),
    );
    const after = await svc.listMyWelcomes(daveAuth, daveDeviceId);
    expect(after.some((w) => w.id === welcomeId)).toBe(false); // consumed
    await expect(
      svc.consumeWelcome(
        daveAuth,
        welcomeId,
        daveDeviceId,
        proofFor(daveDev1Priv, daveDeviceId, welcomeId),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects consume with an invalid proof — 404, and the welcome survives', async () => {
    const conv = await newConversation();
    const { welcomeId } = await svc.deliverWelcome(aliceAuth, conv, wel({ welcome: 'YmFkcA==' }));
    // A proof over the WRONG welcomeId won't verify for this one.
    const wrongProof = proofFor(daveDev1Priv, daveDeviceId, crypto.randomUUID());
    await expect(
      svc.consumeWelcome(daveAuth, welcomeId, daveDeviceId, wrongProof),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect((await svc.listMyWelcomes(daveAuth, daveDeviceId)).some((w) => w.id === welcomeId)).toBe(
      true,
    );
  });

  it('a non-recipient cannot consume another member’s welcome — 404, and the row survives', async () => {
    const conv = await newConversation();
    const { welcomeId } = await svc.deliverWelcome(aliceAuth, conv, wel({ welcome: 'a2VlcA==' }));
    // bob (a member, but not the recipient) — even with a valid proof for his OWN device — can't: the
    // welcome's recipient is dave's device, so the delete predicate matches nothing.
    await expect(
      svc.consumeWelcome(
        bobAuth,
        welcomeId,
        bobDeviceId,
        proofFor(bobDevPriv, bobDeviceId, welcomeId),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    // dave (the recipient) still has it.
    expect((await svc.listMyWelcomes(daveAuth, daveDeviceId)).some((w) => w.id === welcomeId)).toBe(
      true,
    );
  });

  it('a SECOND device of the same user cannot see, forge, or consume device 1’s welcome (multi-device)', async () => {
    const conv = await newConversation();
    const { welcomeId } = await svc.deliverWelcome(aliceAuth, conv, wel({ welcome: 'bXVsdGk=' }));
    // dave's device 2 does not see device 1's welcome...
    expect(
      (await svc.listMyWelcomes(daveAuth, daveDevice2Id)).some((w) => w.id === welcomeId),
    ).toBe(false);
    // ...cannot consume via its own id (wrong recipient_device → no row)...
    await expect(
      svc.consumeWelcome(
        daveAuth,
        welcomeId,
        daveDevice2Id,
        proofFor(daveDev2Priv, daveDevice2Id, welcomeId),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    // ...and cannot FORGE device 1's consume: passing device 1's id but signing with device 2's key
    // fails the proof (it doesn't hold device 1's private key) — the core of Codex P2 #3.
    await expect(
      svc.consumeWelcome(
        daveAuth,
        welcomeId,
        daveDeviceId,
        proofFor(daveDev2Priv, daveDeviceId, welcomeId),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    // device 1 still has it and, with a valid proof, can consume it.
    expect((await svc.listMyWelcomes(daveAuth, daveDeviceId)).some((w) => w.id === welcomeId)).toBe(
      true,
    );
    await svc.consumeWelcome(
      daveAuth,
      welcomeId,
      daveDeviceId,
      proofFor(daveDev1Priv, daveDeviceId, welcomeId),
    );
  });

  it('a revoked member no longer receives the pending welcome (membership cascade)', async () => {
    const conv = await newConversation(); // alice + bob
    await svc.deliverWelcome(aliceAuth, conv, wel({ welcome: 'cmV2b2tl' })); // dave added + welcome
    expect(
      (await svc.listMyWelcomes(daveAuth, daveDeviceId)).some((w) => w.conversationId === conv),
    ).toBe(true);

    // Revoke dave's app-level membership — the pending welcome must not survive it (no join after remove).
    await sql`delete from conversation_members where conversation_id = ${conv} and user_id = ${daveId}`;
    expect(
      (await svc.listMyWelcomes(daveAuth, daveDeviceId)).some((w) => w.conversationId === conv),
    ).toBe(false); // cascaded away — no stale join material
  });

  it('delivering to an existing member is idempotent on membership (no duplicate member row)', async () => {
    const conv = await newConversation(); // bob is already a member
    await svc.deliverWelcome(
      aliceAuth,
      conv,
      wel({ recipientUserId: bobId, recipientDeviceId: bobDeviceId }),
    );
    const [row] =
      await sql`select count(*)::int as n from conversation_members where conversation_id = ${conv} and user_id = ${bobId}`;
    expect((row as { n: number }).n).toBe(1); // still exactly one membership
  });
});
