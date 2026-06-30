// WebAuthn PRF (hmac-secret) keystore unlock. The authenticator derives a per-credential 32-byte secret by
// HMAC'ing a FIXED app salt; that secret is imported as the keystore's AES-GCM unlock key (see lib/keystore.ts
// and packages/crypto importUnlockKey). The salt is NON-SECRET and app-wide — the real key separation is the
// per-passkey PRF key INSIDE the authenticator, which the server never sees. The salt MUST be identical for
// every ceremony (registration + every login) or the keystore becomes permanently unopenable; it is a
// hardcoded constant for exactly that reason. See docs/threat-models/prf-keystore-unlock.md.
//
// @simplewebauthn v13 caveats (verified against the installed source — the bundled DOM types are PRF-unaware
// and the library passes `extensions` through to the native call VERBATIM, never base64url-decoding the eval
// salt): the client must (a) inject the salt as RAW BYTES into options.extensions.prf.eval.first before the
// ceremony, and (b) read the result via a typed accessor (it comes back as a native ArrayBuffer).

import { importUnlockKey } from '@argus/crypto';
import { startAuthentication } from '@simplewebauthn/browser';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

import { getAuthenticateOptions } from './api';

// 32-byte fixed, PUBLIC app salt. Any stable value works; never randomize per-login (that orphans the
// keystore). Bump the `-v1` suffix only with a deliberate keystore reset.
const APP_PRF_SALT = new TextEncoder().encode('argus-prf-keystore-unlock-v1!!!!');

/** A fresh ArrayBuffer-backed copy of the salt — native WebAuthn consumes a BufferSource. */
function prfSaltBytes(): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(APP_PRF_SALT.length);
  copy.set(APP_PRF_SALT);
  return copy;
}

// The v13 DOM types omit `prf`; these describe the shapes we inject / read.
interface PrfExtensionInput {
  eval?: { first: BufferSource; second?: BufferSource };
}
interface PrfExtensionOutput {
  enabled?: boolean;
  results?: { first?: ArrayBuffer; second?: ArrayBuffer };
}

type CeremonyOptions =
  PublicKeyCredentialCreationOptionsJSON | PublicKeyCredentialRequestOptionsJSON;

/**
 * Inject the fixed PRF eval salt (as raw bytes) into the options the server returned, immediately before the
 * ceremony. Mutates + returns the same object. @simplewebauthn won't decode a base64url salt, so it must be
 * bytes here; the bytes ride through the library's verbatim `extensions` passthrough to native create()/get().
 */
export function withPrfSalt<T extends CeremonyOptions>(options: T): T {
  const extensions = (options.extensions ?? {}) as Record<string, unknown> & {
    prf?: PrfExtensionInput;
  };
  extensions.prf = { eval: { first: prfSaltBytes() } };
  (options as { extensions?: unknown }).extensions = extensions;
  return options;
}

/**
 * Pull the 32-byte PRF secret out of a completed ceremony, or null if the authenticator didn't return one
 * (PRF unsupported, or a create() that returned `enabled` only). The result is a native ArrayBuffer.
 */
function readPrfSecret(
  response: RegistrationResponseJSON | AuthenticationResponseJSON,
): Uint8Array | null {
  const ext = response.clientExtensionResults as { prf?: PrfExtensionOutput };
  const first = ext.prf?.results?.first;
  if (!first) return null;
  const secret = new Uint8Array(first);
  return secret.length === 32 ? secret : null;
}

/**
 * Remove the PRF output from a WebAuthn response object IN PLACE. CRYPTO-BLIND BOUNDARY: the response is
 * POSTed verbatim to the server's verify endpoint, but the server must NEVER receive the PRF secret (it's the
 * keystore unlock key for all MLS material). The signature verification does not need it, so we drop it before
 * the response leaves this function. Callers MUST run this before the verify POST.
 */
function stripPrfResults(response: RegistrationResponseJSON | AuthenticationResponseJSON): void {
  const ext = response.clientExtensionResults as { prf?: unknown } | undefined;
  if (ext && 'prf' in ext) delete ext.prf;
}

/**
 * Turn a completed ceremony's PRF output into the keystore unlock key, or null if unavailable, AND strip the
 * PRF secret from the response so it can be POSTed to verify without crossing the crypto-blind boundary. Run
 * this BEFORE the verify POST. The transient secret is wiped after import (the returned CryptoKey is
 * non-extractable).
 */
export async function unlockKeyFromResponse(
  response: RegistrationResponseJSON | AuthenticationResponseJSON,
): Promise<CryptoKey | null> {
  const secret = readPrfSecret(response);
  stripPrfResults(response); // drop the PRF secret before the response is sent to the server
  if (!secret) return null;
  try {
    return await importUnlockKey(secret);
  } finally {
    secret.fill(0);
  }
}

// Transient handoff of the PRF-derived unlock key from the login/registration ceremony to the keystore unlock
// (DeviceContext). Memory only; a non-extractable CryptoKey. Taken (and cleared) exactly once by the unlock
// flow; if empty — e.g. a reload restored the session from the refresh cookie with NO ceremony — the unlock
// flow falls back to `deriveUnlockKeyViaAssertion`.
let pendingUnlockKey: CryptoKey | null = null;

export function stashUnlockKey(key: CryptoKey): void {
  pendingUnlockKey = key;
}

export function takeUnlockKey(): CryptoKey | null {
  const key = pendingUnlockKey;
  pendingUnlockKey = null;
  return key;
}

/**
 * Whether a ceremony already stashed an unlock key (so the gate can unlock with NO new WebAuthn prompt). A
 * fresh assertion (`deriveUnlockKeyViaAssertion`) needs a user gesture, so when this is false the gate must
 * wait for a click rather than auto-triggering on mount.
 */
export function hasPendingUnlockKey(): boolean {
  return pendingUnlockKey !== null;
}

/**
 * Run a standalone WebAuthn assertion (discoverable credential) with the PRF salt and derive the keystore
 * unlock key. Used on reload, when the session was restored from the refresh cookie with no login ceremony,
 * so no PRF secret is in memory. The assertion is NOT verified server-side (a valid session already exists);
 * its only job is to make the authenticator compute the PRF secret. The unconsumed server challenge expires
 * (the auth service sweeps it). Returns null if PRF is unavailable on this authenticator/browser.
 */
export async function deriveUnlockKeyViaAssertion(): Promise<CryptoKey | null> {
  const { options } = await getAuthenticateOptions();
  const response = await startAuthentication({
    optionsJSON: withPrfSalt(options as unknown as PublicKeyCredentialRequestOptionsJSON),
  });
  return unlockKeyFromResponse(response);
}
