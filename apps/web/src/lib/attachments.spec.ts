import { describe, expect, it, vi } from 'vitest';

// Mock the transport; the crypto (encrypt/decrypt) is real.
vi.mock('./api', () => ({
  createUploadGrant: vi.fn(),
  createDownloadGrant: vi.fn(),
  putAttachmentBlob: vi.fn(),
  getAttachmentBlob: vi.fn(),
}));
import {
  createDownloadGrant,
  createUploadGrant,
  getAttachmentBlob,
  putAttachmentBlob,
} from './api';
import { downloadAttachment, uploadAttachment } from './attachments';

const upGrant = vi.mocked(createUploadGrant);
const dlGrant = vi.mocked(createDownloadGrant);
const put = vi.mocked(putAttachmentBlob);
const getBlob = vi.mocked(getAttachmentBlob);

const fileOf = (bytes: Uint8Array, name = 'photo.png', type = 'image/png'): File =>
  new File([new Uint8Array(bytes)], name, { type });

describe('uploadAttachment', () => {
  it('requests a grant with ONLY {conversationId, byteSize}, PUTs the ciphertext, and the ref never carries the key to the server', async () => {
    upGrant.mockResolvedValue({ objectKey: 'tenant/obj', uploadUrl: 'https://sas/put?sig=x' });
    put.mockResolvedValue(undefined);

    const ref = await uploadAttachment('conv-1', fileOf(new Uint8Array([1, 2, 3, 4])));

    // The grant carries the conversation + the CIPHERTEXT length (server caps it) — never the key.
    expect(upGrant).toHaveBeenCalledTimes(1);
    const [conv, byteSize] = upGrant.mock.calls[0]!;
    expect(conv).toBe('conv-1');
    expect(byteSize).toBeGreaterThan(4); // plaintext + the 16-byte GCM tag
    // The ciphertext (not the key) was uploaded to the SAS.
    expect(put).toHaveBeenCalledTimes(1);
    // The returned ref holds the E2E key/iv + objectKey for the envelope — but NEVER a URL.
    expect(ref.objectKey).toBe('tenant/obj');
    expect(typeof ref.key).toBe('string');
    expect(typeof ref.iv).toBe('string');
    expect(ref.name).toBe('photo.png');
    expect(ref.mime).toBe('image/png');
    expect(JSON.stringify(ref)).not.toContain('sas/put'); // the upload URL never lands in the ref
  });

  it('round-trips: download + decrypt recovers the original bytes', async () => {
    upGrant.mockResolvedValue({ objectKey: 'tenant/obj2', uploadUrl: 'https://sas/put' });
    let stored: Uint8Array | undefined;
    put.mockImplementation((_url, ciphertext) => {
      stored = ciphertext;
      return Promise.resolve();
    });
    const original = new Uint8Array([9, 8, 7, 6, 5]);
    const ref = await uploadAttachment(
      'conv-1',
      fileOf(original, 'a.bin', 'application/octet-stream'),
    );

    dlGrant.mockResolvedValue('https://sas/get');
    getBlob.mockResolvedValue(stored!);
    expect([...(await downloadAttachment(ref))]).toEqual([...original]);
  });

  it('download fails closed on a tampered blob (GCM auth)', async () => {
    upGrant.mockResolvedValue({ objectKey: 'tenant/obj3', uploadUrl: 'https://sas/put' });
    let stored: Uint8Array | undefined;
    put.mockImplementation((_url, ciphertext) => {
      stored = ciphertext;
      return Promise.resolve();
    });
    const ref = await uploadAttachment('conv-1', fileOf(new Uint8Array([1, 2, 3])));

    const tampered = new Uint8Array(stored!);
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;
    dlGrant.mockResolvedValue('https://sas/get');
    getBlob.mockResolvedValue(tampered);
    await expect(downloadAttachment(ref)).rejects.toThrow();
  });
});
