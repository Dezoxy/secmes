// Config for the S3-compatible attachment store (encrypted-attachment ciphertext). One mode, two
// deployments — same code path, only the env values differ:
//
//   - LOCAL (MinIO): endpoint http://127.0.0.1:9000, path-style addressing, throwaway root creds.
//   - PROD (Backblaze B2, EU): endpoint https://s3.eu-central-003.backblazeb2.com, virtual-host style, a
//     BUCKET-SCOPED application key (read/write/delete on ONE bucket — least privilege). The key is a
//     long-lived static credential (B2 has no workload-identity equivalent); it lives in Key Vault and is
//     fetched at boot via the VM's Managed Identity — never committed, never logged. Acceptable as
//     long-lived only because the stored blobs are E2EE ciphertext the provider cannot read (invariant #1).
//
// The secret access key is NEVER logged (invariant #2). When unconfigured, the attachment endpoints fail
// closed (see blob-store.module.ts).

export const BLOB_CONFIG = Symbol('BLOB_CONFIG');

export interface BlobConfig {
  /** S3-compatible endpoint (B2: `https://s3.eu-central-003.backblazeb2.com`; MinIO: `http://127.0.0.1:9000`). */
  endpoint: string;
  /** Region — must match the bucket's region for B2 SigV4 (`eu-central-003`); any value for MinIO (`us-east-1`). */
  region: string;
  /** Bucket that holds the (opaque, encrypted) attachment blobs. */
  bucket: string;
  /** Access key id (B2 `keyID` / MinIO root user). Not secret on its own, but pair-with-secret → treat as cred. */
  accessKeyId: string;
  /** Secret access key (B2 `applicationKey` / MinIO root password). NEVER logged or persisted (invariant #2). */
  secretAccessKey: string;
  /** Path-style addressing: `true` for MinIO (no virtual-host DNS), `false` for B2 (virtual-hosted-style). */
  forcePathStyle: boolean;
  configured: boolean;
}

export function loadBlobConfig(): BlobConfig {
  const endpoint = process.env.S3_ENDPOINT ?? '';
  // SigV4 needs SOME region; default to the AWS/MinIO convention. B2 deployments override with their region.
  const region = process.env.S3_REGION || 'us-east-1';
  const bucket = process.env.S3_BUCKET ?? 'argus-attachments';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? '';
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? '';
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true';
  // Configured only when the endpoint, bucket, and BOTH credential halves are present.
  const configured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
  return { endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle, configured };
}
