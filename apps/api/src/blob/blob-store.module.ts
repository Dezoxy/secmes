import { Logger, Module } from '@nestjs/common';

import { AzureBlobStore, UnconfiguredBlobStore } from './azure-blob-store.js';
import { loadBlobConfig } from './blob-config.js';
import { BlobStore } from './blob-store.js';

// Provides the BlobStore. Selects Azure Blob Storage when the blob config is present (local Azurite
// account-key, or a prod account URL + Workload Identity), else a fail-closed store so the attachment
// endpoints 503 instead of misbehaving — the same fail-closed posture as the OIDC config. In prod the SAS is
// signed with a user-delegation key fetched via Workload Identity; NO account key lives in the pod.
@Module({
  providers: [
    {
      provide: BlobStore,
      useFactory: async (): Promise<BlobStore> => {
        const log = new Logger('BlobStore');
        const cfg = loadBlobConfig();
        if (!cfg.configured) {
          log.warn('blob store not configured — attachment endpoints will fail closed');
          return new UnconfiguredBlobStore();
        }
        const store = new AzureBlobStore(cfg);
        // LOCAL-only convenience: ensure the container exists (best-effort — never blocks boot if the
        // emulator is down). Prod creds are read/write only, so the container is provisioned by Terraform.
        if (cfg.createContainer) {
          try {
            await store.ensureContainer();
            log.log(`ensured container ${cfg.container} (local dev)`);
          } catch {
            log.warn(`could not ensure container ${cfg.container} — is the blob emulator up?`);
          }
        }
        if (cfg.accountUrl && cfg.accountKey) {
          log.warn(
            'both BLOB_ACCOUNT_URL and BLOB_ACCOUNT_KEY set — ignoring the key, signing with Workload Identity',
          );
        }
        const mode = cfg.accountUrl
          ? 'user-delegation SAS (Workload Identity)'
          : 'account-key SAS (local)';
        log.log(`using Azure Blob Storage (container ${cfg.container}, ${mode})`);
        return store;
      },
    },
  ],
  exports: [BlobStore],
})
export class BlobStoreModule {}
