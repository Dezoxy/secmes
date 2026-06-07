import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { BlobConfig } from './blob-config.js';
import { BlobStore, PRESIGN_EXPIRY_SECONDS } from './blob-store.js';

/**
 * S3-compatible attachment store (Backblaze B2 in prod, MinIO locally). Only mints short-lived SigV4
 * presigned URLs (capabilities) for a single object + verb; never reads the ciphertext, never sees the
 * content key. The HTTP verb is bound INTO the signature, so a GET-signed URL cannot be replayed as a PUT
 * (least privilege). Presigning is pure local HMAC — no network call — so it can't leak the secret key and
 * can't be a DB dependency inside the upload-grant tx.
 *
 * The presigned URL is a secret-ish capability and MUST never be logged or persisted (invariant #2).
 */
export class S3BlobStore extends BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: BlobConfig) {
    super();
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      // Path-style for MinIO (no per-bucket DNS); virtual-hosted for B2.
      forcePathStyle: cfg.forcePathStyle,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
  }

  /** Actual stored size via HeadObject (metadata only — never reads the ciphertext); null if absent. */
  async blobSize(objectKey: string): Promise<number | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
      return head.ContentLength ?? null;
    } catch (err) {
      if (isNotFound(err)) return null; // not uploaded yet
      throw err;
    }
  }

  presignPut(objectKey: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      {
        expiresIn: PRESIGN_EXPIRY_SECONDS,
      },
    );
  }

  presignGet(objectKey: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      {
        expiresIn: PRESIGN_EXPIRY_SECONDS,
      },
    );
  }
}

/** A missing object surfaces as a 404 / `NotFound` from S3 + B2 + MinIO alike. */
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

/** Fail-closed store used when the blob config is absent — attachment endpoints 503 rather than misbehave. */
export class UnconfiguredBlobStore extends BlobStore {
  private fail(): never {
    throw new Error('blob store is not configured');
  }
  presignPut(): Promise<string> {
    return this.fail();
  }
  presignGet(): Promise<string> {
    return this.fail();
  }
  blobSize(): Promise<number | null> {
    return this.fail();
  }
}
