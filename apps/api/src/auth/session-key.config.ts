// Server-auth infrastructure, not E2EE key material — see docs/threat-models/session-tokens.md §invariant-4.
// EdDSA (Ed25519) is used here for server-issued JWT signing/verification only.
// This is a deliberate, documented exception to invariant #4: `packages/crypto` is the MLS wrapper
// for E2EE message keys; session signing is transport-auth that the server is intended to own.
import { readFile } from 'node:fs/promises';

import { exportJWK, generateKeyPair, importJWK, importPKCS8, type JWK } from 'jose';
import { Logger } from '@nestjs/common';

export const SESSION_KEY_PAIR = Symbol('SESSION_KEY_PAIR');
export const SESSION_SIGNING_KEY = Symbol('SESSION_SIGNING_KEY');
export const SESSION_VERIFY_KEY = Symbol('SESSION_VERIFY_KEY');

export interface SessionKeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

const logger = new Logger('SessionKeyConfig');

/** Load Ed25519 key pair from a file-mounted secret, or generate an ephemeral pair for dev. */
export async function loadSessionKeys(): Promise<SessionKeyPair> {
  const keyFile = process.env['SESSION_SIGNING_KEY_FILE'];

  if (keyFile) {
    // Production path: private key as PKCS8 PEM delivered via Key Vault credential file.
    // The file path comes from the operator (env), never from user input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const pem = await readFile(keyFile, 'utf8');
    const privateKey = (await importPKCS8(pem.trim(), 'EdDSA')) as CryptoKey;
    // Derive the public key: export the private JWK, strip the private scalar (d), reimport.
    const jwk = await exportJWK(privateKey);
    const publicKey = (await importJWK(
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x } as JWK,
      'EdDSA',
    )) as CryptoKey;
    logger.log('session signing key loaded from file');
    return { privateKey, publicKey };
  }

  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'SESSION_SIGNING_KEY_FILE must be set in production — see docs/threat-models/session-tokens.md',
    );
  }

  // Dev fallback: ephemeral key pair. Sessions do not survive API restart, which is acceptable
  // in development. Never used in production (guarded above).
  logger.warn('using ephemeral Ed25519 key pair (dev only — sessions will not survive restart)');
  return generateKeyPair('EdDSA') as Promise<SessionKeyPair>;
}
