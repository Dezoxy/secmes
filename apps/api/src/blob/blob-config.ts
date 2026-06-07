// Config for the S3-compatible blob store (encrypted-attachment ciphertext). Endpoint/bucket/region are
// non-secret; the access/secret keys come from env (Key Vault via Workload ID in prod, the local MinIO dev
// creds locally). When unconfigured, the attachment endpoints fail closed (see blob-store.module.ts).

export const BLOB_CONFIG = Symbol('BLOB_CONFIG');

export interface BlobConfig {
  /** Host only (no scheme/port) — e.g. `localhost` (MinIO) or `s3.eu-central-1.amazonaws.com` (AWS). */
  endpoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
  configured: boolean;
}

export function loadBlobConfig(): BlobConfig {
  const endpoint = process.env.BLOB_ENDPOINT ?? '';
  const useSSL = process.env.BLOB_USE_SSL === 'true';
  const port = Number(process.env.BLOB_PORT ?? (useSSL ? 443 : 9000));
  const accessKey = process.env.BLOB_ACCESS_KEY ?? '';
  const secretKey = process.env.BLOB_SECRET_KEY ?? '';
  const bucket = process.env.BLOB_BUCKET ?? 'argus-attachments';
  const region = process.env.BLOB_REGION ?? 'us-east-1';
  return {
    endpoint,
    port,
    useSSL,
    accessKey,
    secretKey,
    bucket,
    region,
    configured: Boolean(endpoint && accessKey && secretKey && bucket),
  };
}
