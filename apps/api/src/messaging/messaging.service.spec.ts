import { BadRequestException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { getDb } from '../db/index.js';
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
  let carolId: string;
  const svc = new MessagingService();

  let aliceAuth: VerifiedAuth; // tenant A, conversation creator + member
  let bobAuth: VerifiedAuth; // tenant A, member
  let daveAuth: VerifiedAuth; // tenant A, NOT a member
  let carolAuth: VerifiedAuth; // tenant B, other tenant

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
    await sql`insert into users (tenant_id, external_identity_id, email) values (${tenantA}, 'm-dave', 'dave@a.test')`;
    [{ id: carolId }] =
      await sql`insert into users (tenant_id, external_identity_id, email) values (${tenantB}, 'm-carol', 'c@b.test') returning id`;

    aliceAuth = { sub: 'm-alice', tenantId: tenantA };
    bobAuth = { sub: 'm-bob', tenantId: tenantA };
    daveAuth = { sub: 'm-dave', tenantId: tenantA };
    carolAuth = { sub: 'm-carol', tenantId: tenantB };
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

  it('sending to a non-existent conversation returns 404', async () => {
    await expect(svc.sendMessage(bobAuth, crypto.randomUUID(), msg())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
