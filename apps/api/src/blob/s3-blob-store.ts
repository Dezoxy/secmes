import { Client } from 'minio';

import type { BlobConfig } from './blob-config.js';
import { BlobStore, PRESIGN_EXPIRY_SECONDS } from './blob-store.js';

/**
 * S3-compatible blob store via the MinIO client — works against MinIO (local dev) and AWS S3 / R2 / B2 / any
 * S3 store in prod (set `BLOB_ENDPOINT`/region/SSL accordingly). Only mints presigned URLs; never reads the
 * ciphertext, never sees the content key. (Azure Blob would be a separate impl behind `BlobStore`.)
 */
export class S3BlobStore extends BlobStore {
  private readonly client: Client;
  private readonly bucket: string;

  constructor(cfg: BlobConfig) {
    super();
    this.client = new Client({
      endPoint: cfg.endpoint,
      port: cfg.port,
      useSSL: cfg.useSSL,
      accessKey: cfg.accessKey,
      secretKey: cfg.secretKey,
      region: cfg.region,
    });
    this.bucket = cfg.bucket;
  }

  presignPut(objectKey: string): Promise<string> {
    return this.client.presignedPutObject(this.bucket, objectKey, PRESIGN_EXPIRY_SECONDS);
  }

  presignGet(objectKey: string): Promise<string> {
    return this.client.presignedGetObject(this.bucket, objectKey, PRESIGN_EXPIRY_SECONDS);
  }
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
}
