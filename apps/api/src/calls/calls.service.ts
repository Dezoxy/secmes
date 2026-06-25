import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { mintTurnCredential } from '@argus/crypto';
import { and, count, eq, or } from 'drizzle-orm';

import type { TurnCredentialsResponse } from './calls.schemas.js';
import { TURN_SHARED_SECRET } from './calls.config.js';
import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant } from '../db/index.js';
import { requireUser } from '../messaging/membership.js';

/** TURN credential TTL: 600 s (10 min). Short enough that a leaked credential is near-useless;
 *  long enough to set up and complete a relay-only audio call. Clients re-fetch per call attempt. */
const TURN_TTL_SECONDS = 600;

/** TURN server URIs. Non-secret config delivered via TURN_SERVER_HOST env (defaults to local dev). */
function turnUrls(): string[] {
  const host = process.env['TURN_SERVER_HOST'] ?? 'turn.4rgus.com';
  return [`turn:${host}:3478`, `turns:${host}:5349?transport=tcp`];
}

@Injectable()
export class CallsService {
  constructor(@Inject(TURN_SHARED_SECRET) private readonly hmacKey: string) {}

  /**
   * Mint ephemeral TURN credentials for a requester who has ≥1 accepted friend (coarse gate).
   * The gate is requester-only and per-pair-blind: it reflects only the caller's own friend-count,
   * never whether they are friends with a specific callee (docs/planning/voip/04 §2.2, D6/Q7-A).
   *
   * HMAC-SHA1 credential follows the TURN REST API convention coturn implements via use-auth-secret:
   *   username  = "<expiry-unix-ts>:<users.id>"
   *   credential = base64( HMAC-SHA1( username, static-auth-secret ) )
   *
   * The credential is SECRET-EQUIVALENT — never passed to any logger, never returned in errors.
   */
  async mintTurnCredentials(auth: VerifiedAuth): Promise<TurnCredentialsResponse> {
    const userId = await withTenant(auth.tenantId, async (tx) => {
      // requireUser returns users.id (string) directly — throws 404 if the user row is gone.
      const id = await requireUser(tx, auth);

      // Coarse friendship gate: ≥1 accepted friend required (D6/Q7-A).
      // RLS is active inside withTenant — the count is tenant-scoped without an explicit tenant filter.
      const [row] = await tx
        .select({ n: count() })
        .from(schema.friendships)
        .where(
          and(
            eq(schema.friendships.status, 'accepted'),
            or(eq(schema.friendships.userLowId, id), eq(schema.friendships.userHighId, id)),
          ),
        )
        .limit(1);

      if (!row || row.n === 0) {
        throw new ForbiddenException(
          'no accepted friends — TURN credentials require ≥1 accepted friend',
        );
      }

      return id;
    });

    const expiry = Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS;
    const username = `${expiry}:${userId}`;
    const credential = await mintTurnCredential(username, this.hmacKey);

    return {
      iceServers: [{ urls: turnUrls(), username, credential }],
      iceTransportPolicy: 'relay',
      ttlSeconds: TURN_TTL_SECONDS,
    };
  }
}
