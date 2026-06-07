import { randomUUID } from 'node:crypto';

import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { beforeAll, describe, expect, it } from 'vitest';

import type { BlobConfig } from './blob-config.js';
import { S3BlobStore } from './s3-blob-store.js';

// Offline presign assertions — arbitrary creds (no network). DISTINCT access-key-id and secret so the
// "secret never appears in the URL" check is meaningful (the access-key-id legitimately rides in
// X-Amz-Credential; the secret is HMAC input only). Obviously-fake values (not AWS-shaped → no gitleaks).
const OFFLINE: BlobConfig = {
  endpoint: 'http://127.0.0.1:9000',
  region: 'us-east-1',
  bucket: 'argus-attachments-test',
  accessKeyId: 'offline-key-id',
  secretAccessKey: 'offline-signing-secret',
  forcePathStyle: true,
  configured: true,
};

// Local MinIO — throwaway root creds, NOT secrets (same fixed values on every dev machine).
const MINIO: BlobConfig = {
  endpoint: 'http://127.0.0.1:9000',
  region: 'us-east-1',
  bucket: 'argus-attachments-test',
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
  forcePathStyle: true,
  configured: true,
};

// Offline — SigV4 query presigning is pure local HMAC (no network). Always runs (incl. CI).
describe('S3BlobStore — SigV4 presign (offline)', () => {
  const store = new S3BlobStore(OFFLINE);

  it('presignPut mints a signed, expiring URL to the object and never leaks the secret key', async () => {
    const url = await store.presignPut('11111111-1111-1111-1111-111111111111/obj');
    // Path-style: the bucket is in the path, the object key follows.
    expect(url).toContain('/argus-attachments-test/11111111-1111-1111-1111-111111111111/obj');
    expect(url).toMatch(/[?&]X-Amz-Signature=/); // signed
    expect(url).toMatch(/[?&]X-Amz-Expires=/); // has an expiry
    // The credential scope carries the ACCESS KEY ID (not secret), never the secret access key.
    expect(url).toContain('X-Amz-Credential=');
    expect(url).not.toContain(MINIO.secretAccessKey); // the signing secret never appears in the URL
  });

  it('presignGet mints a signed URL to the same object (verb is bound into the signature, not the query)', async () => {
    const url = await store.presignGet('11111111-1111-1111-1111-111111111111/obj');
    expect(url).toContain('/argus-attachments-test/11111111-1111-1111-1111-111111111111/obj');
    expect(url).toMatch(/[?&]X-Amz-Signature=/);
    expect(url).not.toContain(MINIO.secretAccessKey);
  });
});

// Live end-to-end against a running MinIO (`make up`, or `docker run ... minio` on :9000). Set
// RUN_MINIO_E2E=1 to run. Proves the LOCAL path works for real: presign → PUT ciphertext → presign → GET →
// the exact bytes round-trip, and a read URL can't write (the verb is signed). Skipped in CI (no MinIO).
describe.skipIf(!process.env.RUN_MINIO_E2E)('S3BlobStore — live MinIO round-trip', () => {
  const store = new S3BlobStore(MINIO);
  beforeAll(async () => {
    // Test-only bucket creation (the app never creates buckets — see the module comment). MinIO root creds.
    const admin = new S3Client({
      endpoint: MINIO.endpoint,
      region: MINIO.region,
      forcePathStyle: true,
      credentials: { accessKeyId: MINIO.accessKeyId, secretAccessKey: MINIO.secretAccessKey },
    });
    try {
      await admin.send(new CreateBucketCommand({ Bucket: MINIO.bucket }));
    } catch (err) {
      // Already exists (BucketAlreadyOwnedByYou) — fine.
      if ((err as { name?: string }).name !== 'BucketAlreadyOwnedByYou') {
        if (!String((err as { name?: string }).name).includes('AlreadyExists')) throw err;
      }
    }
  });

  it('uploads ciphertext via the presigned PUT and downloads it byte-for-byte via the presigned GET', async () => {
    const key = `33333333-3333-3333-3333-333333333333/${randomUUID()}`;
    const ciphertext = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253]); // opaque AEAD bytes

    const putUrl = await store.presignPut(key);
    const put = await fetch(putUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' }, // unsigned header — S3 accepts it
      body: ciphertext,
    });
    expect(put.status).toBe(200); // S3 PutObject → 200 (Azure block-blob was 201)

    const getUrl = await store.presignGet(key);
    const get = await fetch(getUrl);
    expect(get.status).toBe(200);
    const got = new Uint8Array(await get.arrayBuffer());
    expect([...got]).toEqual([...ciphertext]); // exact round-trip — the server never touched the bytes
  });

  it('a read (GET) presigned URL cannot be used to write (the verb is signed → least privilege)', async () => {
    const key = `33333333-3333-3333-3333-333333333333/${randomUUID()}`;
    const getUrl = await store.presignGet(key);
    const res = await fetch(getUrl, { method: 'PUT', body: new Uint8Array([9]) });
    expect(res.status).toBeGreaterThanOrEqual(400); // the read URL is rejected for a write
  });

  it('blobSize returns the stored byte length (metadata only); null for an absent blob', async () => {
    const key = `33333333-3333-3333-3333-333333333333/${randomUUID()}`;
    const putUrl = await store.presignPut(key);
    await fetch(putUrl, { method: 'PUT', body: new Uint8Array(1234) });
    expect(await store.blobSize(key)).toBe(1234); // actual size, for the hard download cap
    expect(await store.blobSize(`33333333-3333-3333-3333-333333333333/${randomUUID()}`)).toBeNull();
  });
});
