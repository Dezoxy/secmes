import { z } from 'zod';

// Per-attachment POLICY cap (the crypto layer keeps a looser 100 MiB sanity bound). 25 MiB is generous for
// images / short clips; the cap is on the declared byteSize of the ENCRYPTED blob the client will upload.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

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
