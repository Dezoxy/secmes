import { Logger, Module } from '@nestjs/common';

import { loadBlobConfig } from './blob-config.js';
import { BlobStore } from './blob-store.js';
import { S3BlobStore, UnconfiguredBlobStore } from './s3-blob-store.js';

// Provides the BlobStore. Selects the S3-compatible store when the blob config is present (BLOB_ENDPOINT +
// creds + bucket), else a fail-closed store so the attachment endpoints 503 instead of misbehaving — the
// same fail-closed posture as the OIDC config. The creds come from env (Key Vault via Workload ID in prod).
@Module({
  providers: [
    {
      provide: BlobStore,
      useFactory: (): BlobStore => {
        const cfg = loadBlobConfig();
        if (cfg.configured) {
          const log = new Logger('BlobStore');
          // Loud signal for a configured-but-plaintext deploy against a REMOTE host: presigned URLs (and the
          // ciphertext PUT/GET) would cross the network unencrypted. Localhost MinIO over http is expected;
          // a remote endpoint without BLOB_USE_SSL=true is almost always a misconfig. Warn, don't throw — a
          // TLS-terminating sidecar/mesh can legitimately front a plaintext upstream by hostname.
          const local =
            cfg.endpoint === 'localhost' ||
            cfg.endpoint === '::1' ||
            cfg.endpoint.startsWith('127.');
          if (!cfg.useSSL && !local) {
            log.warn(
              `blob endpoint ${cfg.endpoint} is remote but BLOB_USE_SSL is not 'true' — presigning over plaintext; set BLOB_USE_SSL=true unless TLS is terminated in front of it`,
            );
          }
          log.log(`using S3-compatible blob store (bucket ${cfg.bucket})`);
          return new S3BlobStore(cfg);
        }
        new Logger('BlobStore').warn(
          'blob store not configured — attachment endpoints will fail closed',
        );
        return new UnconfiguredBlobStore();
      },
    },
  ],
  exports: [BlobStore],
})
export class BlobStoreModule {}
