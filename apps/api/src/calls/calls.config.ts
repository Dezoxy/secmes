// TURN shared secret — delivered as a Key Vault credential file, never env at rest (invariant #5).
// The API reads it once at startup via TURN_SHARED_SECRET_FILE (the same _FILE pattern as
// SESSION_SIGNING_KEY_FILE). The value is a symmetric HMAC key: SECRET-EQUIVALENT, never logged.
import { readFile } from 'node:fs/promises';

import pino from 'pino';

import { pinoConfig } from '../observability/logger.js';

export const TURN_SHARED_SECRET = Symbol('TURN_SHARED_SECRET');

const logger = pino({ ...pinoConfig, name: 'CallsConfig' });

/** Load the TURN HMAC shared secret from the file-mounted credential. */
export async function loadTurnSharedSecret(): Promise<string> {
  const file = process.env['TURN_SHARED_SECRET_FILE'];
  if (file) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const raw = await readFile(file, 'utf8');
    const secret = raw.trim();
    if (!secret) {
      throw new Error(
        'TURN_SHARED_SECRET_FILE is set but the file is empty — provision argus-turn-shared-secret in Key Vault',
      );
    }
    logger.info('TURN HMAC key loaded from file');
    return secret;
  }

  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'TURN_SHARED_SECRET_FILE must be set in production — see docs/threat-models/voip-turn-credentials.md',
    );
  }

  // Dev fallback: a deterministic dummy — never valid on a real coturn instance but sufficient
  // for local testing of the credential-minting path. Never used in production (guarded above).
  logger.warn('using placeholder TURN HMAC key (dev only)');
  return 'dev-turn-secret-placeholder';
}
