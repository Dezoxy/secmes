import { readFileSync } from 'node:fs';

import { Logger, Module } from '@nestjs/common';

import { InProcessRealtimeBus } from './in-process-realtime-bus.js';
import { RealtimeBus } from './realtime-bus.js';
import { RedisRealtimeBus } from './redis-realtime-bus.js';

/**
 * Resolve the Redis URL WITHOUT the password in env (invariant #5): redis requires AUTH, so the URL carries
 * `redis://:<pw>@redis:6379`. Prefer a file-mounted secret (`REDIS_URL_FILE`) — on the VM a Key-Vault-delivered
 * credential file (Docker secret) deploy.sh generates — over `REDIS_URL` (the LOCAL-dev/test fallback, normally
 * unauthenticated). Putting the password in env would expose it via `docker inspect` / the daemon's at-rest
 * container config; the file path keeps it out, mirroring resolveDatabaseUrl / the S3_SECRET_ACCESS_KEY_FILE
 * pattern. Returns undefined when neither is set (→ in-process bus for dev/tests/single replica).
 */
export function resolveRedisUrl(): string | undefined {
  const file = process.env.REDIS_URL_FILE;
  if (file) {
    // Operator-set deployment path (REDIS_URL_FILE / Docker secret), never user input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return readFileSync(file, 'utf8').trim();
  }
  return process.env.REDIS_URL;
}

// Shared, imported by BOTH the messaging module (publishes) and the realtime module (subscribes) — kept
// in its own module so neither depends on the other (no cycle). Selects the cross-pod Redis bus when a Redis
// URL is configured (REDIS_URL_FILE / REDIS_URL), else the single-pod in-process bus (dev / tests / single replica).
@Module({
  providers: [
    {
      provide: RealtimeBus,
      useFactory: (): RealtimeBus => {
        const url = resolveRedisUrl();
        if (url) {
          new Logger('RealtimeBus').log('using Redis backplane for cross-pod delivery');
          return new RedisRealtimeBus(url);
        }
        return new InProcessRealtimeBus();
      },
    },
  ],
  exports: [RealtimeBus],
})
export class RealtimeBusModule {}
