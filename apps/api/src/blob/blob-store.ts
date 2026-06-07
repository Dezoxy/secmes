// Blob store abstraction (mirrors RealtimeBus) — decouples the attachment endpoints from the storage
// provider. The store holds ONLY opaque ciphertext; the server never reads or writes the content key. All it
// exposes is short-lived PRESIGNED URLs (capabilities): the client uploads/downloads the ciphertext directly
// to/from the store, so the bytes never transit the API. The presigned URLs are secret-ish capabilities and
// MUST never be logged or persisted (invariant #2).

export abstract class BlobStore {
  /** A short-lived presigned PUT URL to upload the encrypted blob to `objectKey`. NEVER log/persist it. */
  abstract presignPut(objectKey: string): Promise<string>;
  /** A short-lived presigned GET URL to download the encrypted blob at `objectKey`. NEVER log/persist it. */
  abstract presignGet(objectKey: string): Promise<string>;
  /**
   * The stored blob's ACTUAL byte size (metadata only — NEVER reads content), or `null` if it doesn't exist
   * yet. Used to hard-enforce the size cap at download, since a SAS PUT can't bind `Content-Length`.
   */
  abstract blobSize(objectKey: string): Promise<number | null>;
}

/** How long a minted presigned URL stays valid — short, since the client uses it immediately. */
export const PRESIGN_EXPIRY_SECONDS = 300; // 5 minutes
