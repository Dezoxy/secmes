// Client-side attachment crypto + transport (A3). Encrypt a file under a FRESH content key, upload the
// CIPHERTEXT to a presigned SAS, and return an E2E ref (the key/iv ride inside the MLS message, never to the
// server). On the way back: download the ciphertext via a download grant and decrypt it (GCM fails closed on
// tamper or a swapped blob). The server is never in the data path and never holds the content key.

import { decryptAttachment, encryptAttachment } from '@argus/crypto';

import {
  createDownloadGrant,
  createUploadGrant,
  getAttachmentBlob,
  putAttachmentBlob,
} from './api';
import type { AttachmentRef } from './message-envelope';

/**
 * Encrypt `file`, upload the ciphertext via a one-time presigned grant, and return the ref to embed in the
 * message envelope. The content key + IV in the returned ref are E2E secrets — they go only inside the
 * encrypted MLS message, never to the server.
 */
export async function uploadAttachment(conversationId: string, file: File): Promise<AttachmentRef> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { key, iv, ciphertext } = await encryptAttachment(bytes);
  const { objectKey, uploadUrl } = await createUploadGrant(conversationId, ciphertext.byteLength);
  await putAttachmentBlob(uploadUrl, ciphertext);
  return {
    objectKey,
    key,
    iv,
    name: file.name,
    mime: file.type || 'application/octet-stream',
    size: bytes.length,
  };
}

/**
 * Download + decrypt one attachment to its plaintext bytes. Authorization (member-only) + the hard size cap
 * are enforced server-side at the download grant; `decryptAttachment` then fails closed (GCM auth) if the
 * stored blob was tampered with or the key is wrong.
 */
export async function downloadAttachment(ref: AttachmentRef): Promise<Uint8Array> {
  const url = await createDownloadGrant(ref.objectKey);
  const ciphertext = await getAttachmentBlob(url);
  return decryptAttachment(ref.key, ref.iv, ciphertext);
}

/** Download + decrypt an attachment and trigger a browser "save as" (for non-image files). */
export async function saveAttachment(ref: AttachmentRef): Promise<void> {
  const bytes = await downloadAttachment(ref);
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: ref.mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = ref.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
