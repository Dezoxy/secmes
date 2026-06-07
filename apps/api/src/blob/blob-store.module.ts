import { Logger, Module } from '@nestjs/common';

import { loadBlobConfig } from './blob-config.js';
import { BlobStore } from './blob-store.js';
import { S3BlobStore, UnconfiguredBlobStore } from './s3-blob-store.js';

// Provides the BlobStore. Selects the S3-compatible store (Backblaze B2 in prod, MinIO locally) when the
// blob config is present, else a fail-closed store so the attachment endpoints 503 instead of misbehaving —
// the same fail-closed posture as the OIDC config. The app NEVER creates or manages the bucket: prod uses a
// bucket-scoped B2 key (object read/write/delete only); the local MinIO bucket is provisioned by the
// `minio-setup` one-shot in compose. Only non-secret config (bucket, endpoint) is logged — never the key.
@Module({
  providers: [
    {
      provide: BlobStore,
      useFactory: (): BlobStore => {
        const log = new Logger('BlobStore');
        const cfg = loadBlobConfig();
        if (!cfg.configured) {
          log.warn('blob store not configured — attachment endpoints will fail closed');
          return new UnconfiguredBlobStore();
        }
        log.log(
          `using S3-compatible blob store (bucket ${cfg.bucket}, endpoint ${cfg.endpoint}, ` +
            `path-style ${cfg.forcePathStyle})`,
        );
        return new S3BlobStore(cfg);
      },
    },
  ],
  exports: [BlobStore],
})
export class BlobStoreModule {}
