import { z } from 'zod';

// Per-attachment POLICY cap (the crypto layer keeps a looser 100 MiB sanity bound). 10 MiB covers images /
// short clips. Checked on the declared byteSize at grant time AND hard-enforced on the blob's ACTUAL size at
// download (an Azure SAS PUT can't bind Content-Length, so the declared value alone is only advisory).
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Upload-grant request: the conversation (membership-gated) + the declared encrypted-blob size. */
export const CreateUploadGrantSchema = z
  .object({
    conversationId: z.string().uuid(),
    byteSize: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
  })
  .strict();
export type CreateUploadGrant = z.infer<typeof CreateUploadGrantSchema>;

/**
 * Download-grant request: the object key the recipient already holds (from the decrypted MLS envelope). An
 * opaque tenant-scoped object key, NEVER a URL — the same shape as the message's `attachmentObjectKey`.
 */
export const CreateDownloadGrantSchema = z
  .object({
    objectKey: z
      .string()
      .min(1)
      .max(512)
      .refine((s) => !s.includes('://'), 'must be an object key, not a URL'),
  })
  .strict();
export type CreateDownloadGrant = z.infer<typeof CreateDownloadGrantSchema>;
