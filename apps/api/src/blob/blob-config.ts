// Config for the Azure Blob Storage attachment store (encrypted-attachment ciphertext). Two modes:
//
//   - LOCAL (Azurite): account name + KEY + blob endpoint → presign with an account-key SAS. The Azurite key
//     is the public well-known dev key (NOT a secret); injected via `make api-dev`.
//   - PROD (Azure): account URL only → presign with a USER-DELEGATION SAS signed via Workload Identity
//     (`DefaultAzureCredential`). No account key ever lives in the pod (invariant #5).
//
// When unconfigured, the attachment endpoints fail closed (see blob-store.module.ts).

export const BLOB_CONFIG = Symbol('BLOB_CONFIG');

export interface BlobConfig {
  /** Storage account name (e.g. `devstoreaccount1` for Azurite, or the real account in prod). */
  accountName: string;
  /** Account key — present ONLY in the local Azurite path (account-key SAS); absent in prod (→ user-delegation). */
  accountKey?: string;
  /** Explicit blob-service URL for the account-key path (Azurite, e.g. `http://127.0.0.1:10000/devstoreaccount1`). */
  endpoint?: string;
  /** Account URL for the prod user-delegation path (e.g. `https://<account>.blob.core.windows.net`). */
  accountUrl?: string;
  /** Container that holds the (opaque, encrypted) attachment blobs. */
  container: string;
  /**
   * Local-only convenience: create the container at startup if missing. NEVER set in prod — prod credentials
   * get blob read/write only (least privilege); the container is provisioned by Terraform.
   */
  createContainer: boolean;
  configured: boolean;
}

export function loadBlobConfig(): BlobConfig {
  const accountName = process.env.BLOB_ACCOUNT_NAME ?? '';
  const accountKey = process.env.BLOB_ACCOUNT_KEY || undefined;
  const endpoint = process.env.BLOB_ENDPOINT || undefined;
  const accountUrl = process.env.BLOB_ACCOUNT_URL || undefined;
  const container = process.env.BLOB_CONTAINER ?? 'argus-attachments';
  const createContainer = process.env.BLOB_CREATE_CONTAINER === 'true';
  // Configured when EITHER the local account-key path (name + key + endpoint) OR the prod path (account URL)
  // is fully present, and a container is named.
  const configured = Boolean(container && ((accountName && accountKey && endpoint) || accountUrl));
  return { accountName, accountKey, endpoint, accountUrl, container, createContainer, configured };
}
