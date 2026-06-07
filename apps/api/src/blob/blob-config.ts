import { readFileSync } from 'node:fs';

// Config for the S3-compatible attachment store (encrypted-attachment ciphertext). One mode, two
// deployments — same code path, only the env values differ:
//
//   - LOCAL (MinIO): endpoint http://127.0.0.1:9000, path-style addressing, throwaway root creds via env.
//   - PROD (Backblaze B2, EU): endpoint https://s3.eu-central-003.backblazeb2.com, virtual-host style, a
//     BUCKET-SCOPED application key (read/write/delete on ONE bucket — least privilege). The key is a
//     long-lived static credential (B2 has no workload-identity equivalent), so it is NEVER placed in the
//     pod env or Helm values (invariant #5): it is delivered as a FILE via `S3_SECRET_ACCESS_KEY_FILE`
//     (systemd `LoadCredential=` on the VM, populated from Azure Key Vault by the VM's Managed Identity at
//     boot). Only the access-key-id (`S3_ACCESS_KEY_ID`) rides in env — it is NOT a secret (it appears in
//     every presigned URL's `X-Amz-Credential`). The secret access key is NEVER logged (invariant #2).
//
// When unconfigured (or the secret file is unreadable), the attachment endpoints fail closed (503).

export const BLOB_CONFIG = Symbol('BLOB_CONFIG');

export interface BlobConfig {
  /** S3-compatible endpoint (B2: `https://s3.eu-central-003.backblazeb2.com`; MinIO: `http://127.0.0.1:9000`). */
  endpoint: string;
  /** Region — must match the bucket's region for B2 SigV4 (`eu-central-003`); any value for MinIO (`us-east-1`). */
  region: string;
  /** Bucket that holds the (opaque, encrypted) attachment blobs. */
  bucket: string;
  /** Access key id (B2 `keyID` / MinIO root user). NOT a secret on its own — it rides in every presigned URL. */
  accessKeyId: string;
  /** Secret access key (B2 `applicationKey` / MinIO root password). NEVER logged or persisted (invariant #2). */
  secretAccessKey: string;
  /** Path-style addressing: `true` for MinIO (no virtual-host DNS), `false` for B2 (virtual-hosted-style). */
  forcePathStyle: boolean;
  configured: boolean;
}

/**
 * Resolve the secret access key WITHOUT requiring it in the pod env (invariant #5). Prefers a file-mounted
 * secret (`S3_SECRET_ACCESS_KEY_FILE`) — on the VM this is a systemd-delivered credential file fetched from
 * Key Vault via the Managed Identity, so the long-lived B2 key never lands in env/Helm. Falls back to the
 * `S3_SECRET_ACCESS_KEY` env var for LOCAL dev only (MinIO throwaway creds). An unreadable file → empty →
 * the store fails closed; we log the PATH only (never the secret).
 */
function resolveSecretAccessKey(): string {
  const file = process.env.S3_SECRET_ACCESS_KEY_FILE;
  if (!file) return process.env.S3_SECRET_ACCESS_KEY ?? '';
  try {
    // Operator-set deployment path (S3_SECRET_ACCESS_KEY_FILE / systemd LoadCredential), never user input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return readFileSync(file, 'utf8').trim();
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      `blob: could not read S3_SECRET_ACCESS_KEY_FILE at ${file} — store will fail closed`,
    );
    return '';
  }
}

export function loadBlobConfig(): BlobConfig {
  const endpoint = process.env.S3_ENDPOINT ?? '';
  // SigV4 needs SOME region; default to the AWS/MinIO convention. B2 deployments override with their region.
  const region = process.env.S3_REGION || 'us-east-1';
  const bucket = process.env.S3_BUCKET ?? 'argus-attachments';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? '';
  const secretAccessKey = resolveSecretAccessKey();
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true';
  // Configured only when the endpoint, bucket, and BOTH credential halves are present.
  const configured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
  return { endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle, configured };
}
