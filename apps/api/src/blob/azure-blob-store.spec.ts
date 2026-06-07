import { randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { BlobConfig } from './blob-config.js';
import { AzureBlobStore } from './azure-blob-store.js';

// Azurite's well-known dev account — PUBLIC, documented, NOT a secret:
// https://github.com/Azure/Azurite#well-known-storage-account-and-key
const AZURITE: BlobConfig = {
  accountName: 'devstoreaccount1',
  accountKey:
    'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==',
  endpoint: 'http://127.0.0.1:10000/devstoreaccount1',
  container: 'argus-attachments-test',
  createContainer: true,
  configured: true,
};

// Offline — account-key SAS signing is pure HMAC (no network). Always runs (incl. CI).
describe('AzureBlobStore — account-key SAS (offline)', () => {
  const store = new AzureBlobStore(AZURITE);

  it('presignPut mints a create+write SAS URL and never leaks the account key', async () => {
    const url = await store.presignPut('11111111-1111-1111-1111-111111111111/obj');
    expect(url).toContain('/argus-attachments-test/11111111-1111-1111-1111-111111111111/obj');
    expect(url).toMatch(/[?&]sig=/); // signed
    expect(url).toMatch(/[?&]se=/); // has an expiry
    expect(url).toContain('sp=cw'); // create + write
    expect(url).not.toContain(AZURITE.accountKey); // the signing key never appears in the URL
  });

  it('presignGet mints a read-only SAS URL', async () => {
    const url = await store.presignGet('11111111-1111-1111-1111-111111111111/obj');
    expect(url).toContain('sp=r'); // read only — not write
    expect(url).not.toContain(AZURITE.accountKey);
  });
});

// Live end-to-end against a running Azurite (`make up`, or `docker run ... azurite` on :10000). Set
// RUN_AZURITE_E2E=1 to run. Proves the LOCAL path works for real: presign → PUT ciphertext → presign → GET →
// the exact bytes round-trip, and a read SAS can't write (least privilege). Skipped in CI (no Azurite).
describe.skipIf(!process.env.RUN_AZURITE_E2E)('AzureBlobStore — live Azurite round-trip', () => {
  const store = new AzureBlobStore(AZURITE);
  beforeAll(async () => {
    await store.ensureContainer();
  });

  it('uploads ciphertext via the presigned PUT and downloads it byte-for-byte via the presigned GET', async () => {
    const key = `33333333-3333-3333-3333-333333333333/${randomUUID()}`;
    const ciphertext = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253]); // opaque AEAD bytes

    const putUrl = await store.presignPut(key);
    const put = await fetch(putUrl, {
      method: 'PUT',
      headers: { 'x-ms-blob-type': 'BlockBlob' }, // Azure block-blob create contract (the A3 client must send this)
      body: ciphertext,
    });
    expect(put.status).toBe(201);

    const getUrl = await store.presignGet(key);
    const get = await fetch(getUrl);
    expect(get.status).toBe(200);
    const got = new Uint8Array(await get.arrayBuffer());
    expect([...got]).toEqual([...ciphertext]); // exact round-trip — the server never touched the bytes
  });

  it('a read-only SAS cannot be used to write (least privilege)', async () => {
    const key = `33333333-3333-3333-3333-333333333333/${randomUUID()}`;
    const getUrl = await store.presignGet(key);
    const res = await fetch(getUrl, {
      method: 'PUT',
      headers: { 'x-ms-blob-type': 'BlockBlob' },
      body: new Uint8Array([9]),
    });
    expect(res.status).toBeGreaterThanOrEqual(400); // the read SAS is rejected for a write
  });

  it('blobSize returns the stored byte length (metadata only); null for an absent blob', async () => {
    const key = `33333333-3333-3333-3333-333333333333/${randomUUID()}`;
    const putUrl = await store.presignPut(key);
    await fetch(putUrl, {
      method: 'PUT',
      headers: { 'x-ms-blob-type': 'BlockBlob' },
      body: new Uint8Array(1234),
    });
    expect(await store.blobSize(key)).toBe(1234); // actual size, for the hard download cap
    expect(await store.blobSize(`33333333-3333-3333-3333-333333333333/${randomUUID()}`)).toBeNull();
  });
});
