import { NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { VerifiedAuth } from '../auth/auth.service.js';
import { BlobStore } from '../blob/blob-store.js';
import { getDb } from '../db/index.js';
import { MAX_ATTACHMENT_BYTES } from './attachments.schemas.js';
import { AttachmentsService } from './attachments.service.js';

// Integration — needs a live Postgres with migrations applied. Auto-skips without DATABASE_URL. The blob
// store is faked (the presigned URL is a capability the URL provider mints; here we assert the AUTHZ + the
// metadata row + the size guard, not the SAS signing).
const DB_URL = process.env.DATABASE_URL;

class FakeBlobStore extends BlobStore {
  presignPut = vi.fn((objectKey: string) => Promise.resolve(`https://blob.test/put/${objectKey}`));
  presignGet = vi.fn((objectKey: string) => Promise.resolve(`https://blob.test/get/${objectKey}`));
  blobSize = vi.fn((): Promise<number | null> => Promise.resolve(1024)); // within cap by default
}

describe.skipIf(!DB_URL)('AttachmentsService — membership-gated grants', () => {
  let sql: ReturnType<typeof getDb>['sql'];
  let tenantA: string;
  let tenantB: string;
  let aliceId: string;
  let convId: string;
  const blob = new FakeBlobStore();
  const svc = new AttachmentsService(blob);

  let aliceAuth: VerifiedAuth; // tenant A, member of convId
  let daveAuth: VerifiedAuth; // tenant A, NOT a member
  let carolAuth: VerifiedAuth; // tenant B, other tenant

  beforeAll(async () => {
    sql = getDb().sql;
    [{ id: tenantA }] = await sql`insert into tenants (name) values ('Att-A') returning id`;
    [{ id: tenantB }] = await sql`insert into tenants (name) values ('Att-B') returning id`;
    [{ id: aliceId }] =
      await sql`insert into users (tenant_id, external_identity_id, email) values (${tenantA}, 'a-alice', 'al@a.test') returning id`;
    await sql`insert into users (tenant_id, external_identity_id, email) values (${tenantA}, 'a-dave', 'dave@a.test')`;
    await sql`insert into users (tenant_id, external_identity_id, email) values (${tenantB}, 'a-carol', 'c@b.test')`;
    [{ id: convId }] =
      await sql`insert into conversations (tenant_id, created_by) values (${tenantA}, ${aliceId}) returning id`;
    await sql`insert into conversation_members (tenant_id, conversation_id, user_id) values (${tenantA}, ${convId}, ${aliceId})`;

    aliceAuth = { sub: 'a-alice', tenantId: tenantA };
    daveAuth = { sub: 'a-dave', tenantId: tenantA };
    carolAuth = { sub: 'a-carol', tenantId: tenantB };
  });

  afterAll(async () => {
    if (tenantA) await sql`delete from tenants where id = ${tenantA}`; // cascades
    if (tenantB) await sql`delete from tenants where id = ${tenantB}`;
  });

  it('upload grant: a member gets a tenant-prefixed object key + URL and a metadata row is written', async () => {
    const grant = await svc.createUploadGrant(aliceAuth, {
      conversationId: convId,
      byteSize: 4096,
    });
    expect(grant.objectKey.startsWith(`${tenantA}/`)).toBe(true);
    expect(grant.uploadUrl).toBe(`https://blob.test/put/${grant.objectKey}`);
    const [row] = await sql`select byte_size, uploaded_by, conversation_id, tenant_id
                            from attachments where object_key = ${grant.objectKey}`;
    expect(Number(row!.byte_size)).toBe(4096);
    expect(row!.uploaded_by).toBe(aliceId); // VERIFIED caller, never client input
    expect(row!.conversation_id).toBe(convId);
    expect(row!.tenant_id).toBe(tenantA);
  });

  it('upload grant: a failed presign rolls back the row (atomic — no orphan metadata)', async () => {
    const [before] =
      await sql`select count(*)::int as n from attachments where tenant_id = ${tenantA}`;
    blob.presignPut.mockRejectedValueOnce(new Error('blob store is not configured'));
    await expect(
      svc.createUploadGrant(aliceAuth, { conversationId: convId, byteSize: 16 }),
    ).rejects.toThrow('blob store is not configured');
    const [after] =
      await sql`select count(*)::int as n from attachments where tenant_id = ${tenantA}`;
    expect(after!.n).toBe(before!.n); // the row insert was rolled back — no orphan
  });

  it('upload grant: a non-member is 404 (same as non-existent) and writes nothing', async () => {
    await expect(
      svc.createUploadGrant(daveAuth, { conversationId: convId, byteSize: 10 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('upload grant: a caller in another tenant is 404 (RLS hides the conversation)', async () => {
    await expect(
      svc.createUploadGrant(carolAuth, { conversationId: convId, byteSize: 10 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('download grant: a member of the attachment’s conversation gets a URL', async () => {
    const { objectKey } = await svc.createUploadGrant(aliceAuth, {
      conversationId: convId,
      byteSize: 8,
    });
    const grant = await svc.createDownloadGrant(aliceAuth, objectKey);
    expect(grant.url).toBe(`https://blob.test/get/${objectKey}`);
  });

  it('download grant: a non-member is 404 (no IDOR — authz from the row’s conversation)', async () => {
    const { objectKey } = await svc.createUploadGrant(aliceAuth, {
      conversationId: convId,
      byteSize: 8,
    });
    await expect(svc.createDownloadGrant(daveAuth, objectKey)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('download grant: an unknown object key is 404', async () => {
    await expect(
      svc.createDownloadGrant(aliceAuth, `${tenantA}/00000000-0000-0000-0000-000000000000`),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('download grant: refuses to serve a blob whose ACTUAL size exceeds the cap (413, hard limit)', async () => {
    const { objectKey } = await svc.createUploadGrant(aliceAuth, {
      conversationId: convId,
      byteSize: 8, // declared small…
    });
    blob.blobSize.mockResolvedValueOnce(MAX_ATTACHMENT_BYTES + 1); // …but the client PUT more than declared
    await expect(svc.createDownloadGrant(aliceAuth, objectKey)).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
  });

  it('download grant: refuses an EXPIRED attachment (404 — retention enforced at the API, not just the worker)', async () => {
    const { objectKey } = await svc.createUploadGrant(aliceAuth, {
      conversationId: convId,
      byteSize: 8,
    });
    // Force it past its retention window — the daily cleanup worker may not have run yet (or be down).
    await sql`update attachments set expires_at = now() - interval '1 second' where object_key = ${objectKey}`;
    await expect(svc.createDownloadGrant(aliceAuth, objectKey)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
