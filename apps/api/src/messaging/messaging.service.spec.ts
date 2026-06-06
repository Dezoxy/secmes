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
});
