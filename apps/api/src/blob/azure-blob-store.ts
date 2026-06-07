import { DefaultAzureCredential } from '@azure/identity';
import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';

import type { BlobConfig } from './blob-config.js';
import { BlobStore, PRESIGN_EXPIRY_SECONDS } from './blob-store.js';

/**
 * Azure Blob Storage attachment store. Only mints short-lived SAS URLs (capabilities); never reads the
 * ciphertext, never sees the content key. Two signing modes, chosen by config:
 *
 *   - LOCAL (Azurite): account-key SAS (`StorageSharedKeyCredential`). The Azurite key is the public
 *     well-known dev key — not a secret.
 *   - PROD (Azure): USER-DELEGATION SAS — the delegation key is fetched via Workload Identity
 *     (`DefaultAzureCredential`), so NO account key ever lives in the pod (invariant #5).
 *
 * The presigned URL is a secret-ish capability and MUST never be logged or persisted (invariant #2).
 */
export class AzureBlobStore extends BlobStore {
  private readonly service: BlobServiceClient;
  private readonly container: string;
  private readonly accountName: string;
  private readonly sharedKey?: StorageSharedKeyCredential;
  private readonly https: boolean;

  constructor(cfg: BlobConfig) {
    super();
    this.container = cfg.container;
    if (cfg.accountUrl) {
      // PROD: account URL → user-delegation SAS via Workload Identity (DefaultAzureCredential). Checked
      // FIRST so a pod that ALSO receives an account key (stray env, leaked Key Vault entry) can never
      // silently downgrade to account-key signing — invariant #5 fails closed, not open. No key in the pod.
      this.service = new BlobServiceClient(cfg.accountUrl, new DefaultAzureCredential());
      this.accountName = this.service.accountName;
      this.https = true;
    } else if (cfg.accountKey && cfg.endpoint) {
      // LOCAL (Azurite): account-key SAS — only when NO account URL is set.
      this.sharedKey = new StorageSharedKeyCredential(cfg.accountName, cfg.accountKey);
      this.service = new BlobServiceClient(cfg.endpoint, this.sharedKey);
      this.accountName = cfg.accountName;
      this.https = cfg.endpoint.startsWith('https');
    } else {
      throw new Error(
        'blob store: need BLOB_ACCOUNT_URL (prod) or BLOB_ACCOUNT_KEY + BLOB_ENDPOINT (local)',
      );
    }
  }

  /** Create the container if missing — LOCAL-dev convenience only (prod creds are read/write, not manage). */
  async ensureContainer(): Promise<void> {
    await this.service.getContainerClient(this.container).createIfNotExists();
  }

  presignPut(objectKey: string): Promise<string> {
    return this.sign(objectKey, BlobSASPermissions.parse('cw')); // create + write
  }

  presignGet(objectKey: string): Promise<string> {
    return this.sign(objectKey, BlobSASPermissions.parse('r')); // read only
  }

  private async sign(blobName: string, permissions: BlobSASPermissions): Promise<string> {
    const now = Date.now();
    const startsOn = new Date(now - 60_000); // small clock-skew allowance
    const expiresOn = new Date(now + PRESIGN_EXPIRY_SECONDS * 1000);
    const values = {
      containerName: this.container,
      blobName,
      permissions,
      startsOn,
      expiresOn,
      protocol: this.https ? SASProtocol.Https : SASProtocol.HttpsAndHttp,
    };
    const sas = this.sharedKey
      ? generateBlobSASQueryParameters(values, this.sharedKey).toString()
      : generateBlobSASQueryParameters(
          values,
          await this.service.getUserDelegationKey(startsOn, expiresOn),
          this.accountName,
        ).toString();
    const url = this.service.getContainerClient(this.container).getBlockBlobClient(blobName).url;
    return `${url}?${sas}`;
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
