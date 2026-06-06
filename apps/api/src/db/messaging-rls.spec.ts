import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDb } from './index.js';

// Integration test — proves PostgreSQL itself isolates the messaging tables by tenant and keeps
// messages append-only (roadmap checkpoint 25). Requires a live Postgres with migrations applied:
//   make up && pnpm --filter @argus/api db:migrate
// Auto-skips where no DATABASE_URL is set (the unit-only CI job).
const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('messaging schema RLS + append-only (checkpoint 25)', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let userB: string;
  let deviceA: string; // a device of userA (welcomes are sealed to a specific device)
  let convA: string; // a conversation owned by tenant A
  let convB: string; // a conversation owned by tenant B (proves disjoint isolation)

  // Same shape as the app's withTenant(): non-bypass role + tx-local tenant context.
  function asTenant(tenantId: string, fn: (tx: typeof sql) => unknown): Promise<unknown> {
    return sql.begin(async (tx) => {
      await tx`set local role argus_app`;
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx as unknown as typeof sql);
    }) as Promise<unknown>;
  }

  beforeAll(async () => {
    sql = getDb().sql;
    // Seed as the owner connection (bypasses RLS for setup only).
    [{ id: tenantA }] = await sql`insert into tenants (name) values ('Msg Tenant A') returning id`;
    [{ id: tenantB }] = await sql`insert into tenants (name) values ('Msg Tenant B') returning id`;
    [{ id: userA }] = await sql`insert into users (tenant_id, external_identity_id, email)
                                values (${tenantA}, 'msg-ext-a', 'msg-a@a.test') returning id`;
    [{ id: userB }] = await sql`insert into users (tenant_id, external_identity_id, email)
                                values (${tenantB}, 'msg-ext-b', 'msg-b@b.test') returning id`;
    [{ id: deviceA }] = await sql`insert into devices (tenant_id, user_id, signature_public_key)
                                  values (${tenantA}, ${userA}, 'msg-rls-sig-a') returning id`;
  });

  afterAll(async () => {
    if (sql) {
      await sql`delete from tenants where id in (${tenantA}, ${tenantB})`; // cascades members/messages
      await sql.end({ timeout: 5 });
    }
  });

  // Create a conversation + member + one message under `tenant`/`user`; returns the conversation id.
  function makeConversation(tenant: string, user: string): Promise<string> {
    return asTenant(tenant, async (tx) => {
      const [c] = await tx`insert into conversations (tenant_id, created_by)
                           values (${tenant}, ${user}) returning id`;
      const cid = (c as { id: string }).id;
      await tx`insert into conversation_members (tenant_id, conversation_id, user_id)
               values (${tenant}, ${cid}, ${user})`;
      await tx`insert into messages
                 (tenant_id, conversation_id, sender_user_id, client_message_id, ciphertext, alg, epoch)
               values (${tenant}, ${cid}, ${user}, gen_random_uuid(), 'b64-ciphertext', 'MLS_1.0', 0)`;
      return cid;
    }) as Promise<string>;
  }

  it('each tenant can create a conversation, add a member, and send a message', async () => {
    convA = await makeConversation(tenantA, userA);
    convB = await makeConversation(tenantB, userB);
    expect(convA).toBeTruthy();
    expect(convB).toBeTruthy();
    expect(convA).not.toBe(convB);
  });

  it('a tenant reads only its own conversations / members / messages', async () => {
    const seen = (await asTenant(tenantA, async (tx) => {
      const convs = await tx`select id, tenant_id from conversations`;
      const mems = await tx`select tenant_id from conversation_members`;
      const msgs = await tx`select tenant_id, ciphertext from messages`;
      return { convs, mems, msgs };
    })) as {
      convs: Array<{ id: string; tenant_id: string }>;
      mems: Array<{ tenant_id: string }>;
      msgs: Array<{ tenant_id: string; ciphertext: string }>;
    };
    const convIds = seen.convs.map((r) => r.id);
    expect(convIds).toContain(convA);
    expect(convIds).not.toContain(convB); // B's conversation is invisible to A
    expect(seen.convs.every((r) => r.tenant_id === tenantA)).toBe(true);
    expect(seen.mems.every((r) => r.tenant_id === tenantA)).toBe(true);
    expect(seen.msgs.length).toBeGreaterThan(0);
    expect(seen.msgs.every((r) => r.tenant_id === tenantA)).toBe(true);
  });

  it("tenant B sees only its own conversations, never tenant A's", async () => {
    const ids = (await asTenant(
      tenantB,
      (tx) => tx`select id, tenant_id from conversations`,
    )) as Array<{ id: string; tenant_id: string }>;
    const list = ids.map((r) => r.id);
    expect(list).toContain(convB);
    expect(list).not.toContain(convA);
    expect(ids.every((r) => r.tenant_id === tenantB)).toBe(true);
  });

  it('WITH CHECK blocks writing a message into another tenant', async () => {
    await expect(
      asTenant(
        tenantA,
        (tx) => tx`insert into messages
                     (tenant_id, conversation_id, sender_user_id, client_message_id, ciphertext, alg, epoch)
                   values (${tenantB}, ${convA}, ${userA}, gen_random_uuid(), 'x', 'MLS_1.0', 0)`,
      ),
    ).rejects.toThrow();
  });

  it('messages are append-only for the app role (no update / delete grant)', async () => {
    await expect(
      asTenant(tenantA, (tx) => tx`update messages set ciphertext = 'tampered'`),
    ).rejects.toThrow();
    await expect(asTenant(tenantA, (tx) => tx`delete from messages`)).rejects.toThrow();
  });

  it('the idempotency index rejects a duplicate (sender, client_message_id)', async () => {
    const cmid = crypto.randomUUID(); // CSPRNG (WebCrypto) — same id reused to trip the unique index
    await expect(
      asTenant(tenantA, async (tx) => {
        const ins = (): unknown =>
          tx`insert into messages
               (tenant_id, conversation_id, sender_user_id, client_message_id, ciphertext, alg, epoch)
             values (${tenantA}, ${convA}, ${userA}, ${cmid}, 'c', 'MLS_1.0', 1)`;
        await ins();
        await ins(); // same (sender, client_message_id) → unique violation
      }),
    ).rejects.toThrow();
  });

  it('composite FK blocks a message referencing another tenant’s conversation', async () => {
    // tenant_id = B passes RLS (matches the context), but conversation_id is A's conversation, so the
    // composite FK (B, convA) -> conversations(tenant_id, id) finds no row and rejects the write.
    await expect(
      asTenant(
        tenantB,
        (tx) => tx`insert into messages
                     (tenant_id, conversation_id, sender_user_id, client_message_id, ciphertext, alg, epoch)
                   values (${tenantB}, ${convA}, ${userB}, gen_random_uuid(), 'x', 'MLS_1.0', 0)`,
      ),
    ).rejects.toThrow();
  });

  it('composite FK blocks referencing a user from another tenant', async () => {
    // tenant B (RLS-valid tenant_id) names tenant A's user as created_by — (B, userA) is not in
    // users(tenant_id, id), so the composite FK rejects the write.
    await expect(
      asTenant(
        tenantB,
        (tx) => tx`insert into conversations (tenant_id, created_by) values (${tenantB}, ${userA})`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a negative epoch (check constraint)', async () => {
    await expect(
      asTenant(
        tenantA,
        (tx) => tx`insert into messages
                     (tenant_id, conversation_id, sender_user_id, client_message_id, ciphertext, alg, epoch)
                   values (${tenantA}, ${convA}, ${userA}, gen_random_uuid(), 'x', 'MLS_1.0', -1)`,
      ),
    ).rejects.toThrow();
  });

  it('preserves history: deleting a user with messages is blocked (NO ACTION, not cascade)', async () => {
    // userA created convA and sent a message. A direct user delete must NOT cascade-erase that history;
    // the NO ACTION FKs (created_by / sender_user_id) block the delete.
    await expect(
      asTenant(tenantA, (tx) => tx`delete from users where id = ${userA}`),
    ).rejects.toThrow();
  });

  it('a tenant teardown still cascades its conversations + messages (NO ACTION does not block it)', async () => {
    // A throwaway tenant, fully populated, then deleted as owner — proves NO ACTION on the user refs
    // does not block tenant teardown (users + messages are co-deleted in the one statement).
    const [t] = await sql`insert into tenants (name) values ('Teardown Tenant') returning id`;
    const tid = (t as { id: string }).id;
    const [u] = await sql`insert into users (tenant_id, external_identity_id, email)
                          values (${tid}, 'td-ext', 'td@t.test') returning id`;
    await makeConversation(tid, (u as { id: string }).id);

    await sql`delete from tenants where id = ${tid}`; // must not throw — cascades everything
    const [row] = await sql`select count(*)::int as n from messages where tenant_id = ${tid}`;
    expect((row as { n: number }).n).toBe(0);
  });

  it('removing a membership cascade-deletes that member’s receipt (re-add starts clean)', async () => {
    // A receipt is OWNED BY its membership. When a member is removed and later re-added, the old
    // delivery/read watermark must NOT resurface (PR #55 finding). The conversation_receipts ->
    // conversation_members composite FK (ON DELETE CASCADE) enforces this at the schema level — and
    // the cascade fires for the non-superuser app role under FORCE RLS (the real removal path).
    const cid = await makeConversation(tenantA, userA); // conversation + membership(userA) + a message
    await asTenant(
      tenantA,
      (tx) => tx`insert into conversation_receipts
                   (tenant_id, conversation_id, user_id, delivered_through_created_at, delivered_at)
                 values (${tenantA}, ${cid}, ${userA}, now(), now())`,
    );
    const [receiptsBefore] = (await asTenant(
      tenantA,
      (tx) =>
        tx`select count(*)::int as n from conversation_receipts where conversation_id = ${cid}`,
    )) as Array<{ n: number }>;
    expect((receiptsBefore as { n: number }).n).toBe(1);

    // Remove the membership as the app role (argus_app holds DELETE on conversation_members).
    await asTenant(
      tenantA,
      (tx) =>
        tx`delete from conversation_members where conversation_id = ${cid} and user_id = ${userA}`,
    );

    const [receiptsAfter] = (await asTenant(
      tenantA,
      (tx) =>
        tx`select count(*)::int as n from conversation_receipts where conversation_id = ${cid}`,
    )) as Array<{ n: number }>;
    expect((receiptsAfter as { n: number }).n).toBe(0); // cascade fired — no stale watermark survives re-add
    // The message stays: deleting a membership is not deleting history (messages FK is not to members).
    const [msgRow] = (await asTenant(
      tenantA,
      (tx) => tx`select count(*)::int as n from messages where conversation_id = ${cid}`,
    )) as Array<{ n: number }>;
    expect((msgRow as { n: number }).n).toBeGreaterThan(0);
  });

  it('no tenant context => fail closed on messages', async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`set local role argus_app`;
        return tx`select count(*) from messages`;
      }),
    ).rejects.toThrow();
  });

  // ── MLS Welcome delivery (welcome-delivery.md) ───────────────────────────────────────────────────
  it('conversation_welcomes isolates by tenant (RLS) and WITH CHECK blocks cross-tenant writes', async () => {
    // A welcome in tenant A (recipient + sender = userA, device = deviceA, in convA — opaque blobs).
    await asTenant(
      tenantA,
      (tx) => tx`insert into conversation_welcomes
                   (tenant_id, conversation_id, recipient_user_id, recipient_device_id, sender_user_id, welcome, ratchet_tree)
                 values (${tenantA}, ${convA}, ${userA}, ${deviceA}, ${userA}, 'b64-welcome', 'b64-tree')`,
    );
    // Tenant B sees NONE of A's welcomes.
    const [bSees] = (await asTenant(
      tenantB,
      (tx) => tx`select count(*)::int as n from conversation_welcomes`,
    )) as Array<{ n: number }>;
    expect((bSees as { n: number }).n).toBe(0);
    // Tenant A sees its own.
    const [aSees] = (await asTenant(
      tenantA,
      (tx) =>
        tx`select count(*)::int as n from conversation_welcomes where conversation_id = ${convA}`,
    )) as Array<{ n: number }>;
    expect((aSees as { n: number }).n).toBeGreaterThan(0);
    // WITH CHECK: tenant A cannot write a welcome stamped tenant B.
    await expect(
      asTenant(
        tenantA,
        (tx) => tx`insert into conversation_welcomes
                     (tenant_id, conversation_id, recipient_user_id, recipient_device_id, sender_user_id, welcome, ratchet_tree)
                   values (${tenantB}, ${convA}, ${userA}, ${deviceA}, ${userA}, 'x', 'y')`,
      ),
    ).rejects.toThrow();
  });

  it('welcomes are transient for the app role: delete is granted, update is NOT', async () => {
    // argus_app holds select/insert/delete (the recipient consumes on join) but NO update — a stored
    // welcome can't be silently altered server-side.
    await expect(
      asTenant(tenantA, (tx) => tx`update conversation_welcomes set welcome = 'tampered'`),
    ).rejects.toThrow();
    // delete IS allowed (consume).
    await asTenant(
      tenantA,
      (tx) => tx`delete from conversation_welcomes where conversation_id = ${convA}`,
    );
  });

  it('deleting a conversation cascades its pending welcomes', async () => {
    // A conversation with a member + a welcome (the welcome's membership FK requires the member to exist).
    const cid = (await asTenant(tenantA, async (tx) => {
      const [c] = await tx`insert into conversations (tenant_id, created_by)
                           values (${tenantA}, ${userA}) returning id`;
      const id = (c as { id: string }).id;
      await tx`insert into conversation_members (tenant_id, conversation_id, user_id)
               values (${tenantA}, ${id}, ${userA})`;
      await tx`insert into conversation_welcomes
                 (tenant_id, conversation_id, recipient_user_id, recipient_device_id, sender_user_id, welcome, ratchet_tree)
               values (${tenantA}, ${id}, ${userA}, ${deviceA}, ${userA}, 'w', 't')`;
      return id;
    })) as string;
    await sql`delete from conversations where id = ${cid}`; // composite FK ON DELETE CASCADE removes the welcome
    const [row] =
      await sql`select count(*)::int as n from conversation_welcomes where conversation_id = ${cid}`;
    expect((row as { n: number }).n).toBe(0);
  });

  it('revoking a membership cascade-deletes that member’s pending welcome', async () => {
    // A pending welcome is OWNED BY the recipient's membership — an app-level remove must NOT leave stale
    // join material the removed member could still fetch and use to join. (Mirrors the receipts cascade.)
    const cid = await makeConversation(tenantA, userA); // conversation + membership(userA) + a message
    await asTenant(
      tenantA,
      (tx) => tx`insert into conversation_welcomes
                   (tenant_id, conversation_id, recipient_user_id, recipient_device_id, sender_user_id, welcome, ratchet_tree)
                 values (${tenantA}, ${cid}, ${userA}, ${deviceA}, ${userA}, 'w', 't')`,
    );
    await asTenant(
      tenantA,
      (tx) =>
        tx`delete from conversation_members where conversation_id = ${cid} and user_id = ${userA}`,
    );
    const [row] =
      await sql`select count(*)::int as n from conversation_welcomes where conversation_id = ${cid}`;
    expect((row as { n: number }).n).toBe(0); // cascaded — no stale join material survives the remove
    // The message stays (its FK is to the conversation, not the membership) — removal ≠ deleting history.
    const [msg] = await sql`select count(*)::int as n from messages where conversation_id = ${cid}`;
    expect((msg as { n: number }).n).toBeGreaterThan(0);
  });

  it('no tenant context => fail closed on conversation_welcomes', async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`set local role argus_app`;
        return tx`select count(*) from conversation_welcomes`;
      }),
    ).rejects.toThrow();
  });
});
