// Device proof-of-possession for MLS Welcome ops (welcome-delivery.md). The access token proves the
// USER (`sub`), not which DEVICE a session is. A pending MLS Welcome is HPKE-sealed to ONE device's
// claimed KeyPackage; to fetch its blobs or consume (delete) it, the caller proves possession of THAT
// device's Ed25519 signature private key by signing a domain-separated message. The crypto-blind server
// verifies the proof against the device's PUBLIC signature key (published in the key directory) — an
// authentication check over public keys, never content decryption (invariant #1 holds).
//
// Ed25519 via @noble/curves is an audited primitive (the device's MLS signature scheme for the v1
// suite), not hand-rolled. This module deliberately imports NO ts-mls, so the server can verify proofs
// without loading the MLS WASM. See the `./device-proof` package export.
import { ed25519 } from '@noble/curves/ed25519.js';

const te = new TextEncoder();

// Domain-separated per OPERATION + version, so an app-level proof can never collide with an MLS protocol
// signature (cross-protocol confusion) AND a `fetch` proof can't be replayed as a `consume` proof (least
// authority). Binds the op + the specific device + the welcome. Replay-safe across welcomes because
// `welcomeId` is a fresh, single-use id (consume deletes the row); the proof carries no token value.
function proofMessage(op: 'consume' | 'fetch', deviceId: string, welcomeId: string): Uint8Array {
  return te.encode(`argus-welcome-${op}:v1\n${deviceId}\n${welcomeId}`);
}

function sign(
  op: 'consume' | 'fetch',
  signaturePrivateKey: Uint8Array,
  deviceId: string,
  welcomeId: string,
): Uint8Array {
  return ed25519.sign(proofMessage(op, deviceId, welcomeId), signaturePrivateKey);
}

// Verify is TOTAL: returns false (never throws) on a forged / tampered / malformed proof or key, so
// callers map any failure to one opaque 404. Signature non-malleability is intentionally NOT relied
// upon — anti-replay comes from the fresh single-use `welcomeId`, not the signature bytes — so the proof
// must never be repurposed as a dedup/idempotency token.
function verify(
  op: 'consume' | 'fetch',
  signaturePublicKey: Uint8Array,
  deviceId: string,
  welcomeId: string,
  signature: Uint8Array,
): boolean {
  try {
    return ed25519.verify(signature, proofMessage(op, deviceId, welcomeId), signaturePublicKey);
  } catch {
    return false;
  }
}

/**
 * Sign a CONSUME proof with the DEVICE's Ed25519 signature private key
 * (`DeviceKeys.privatePackage.signaturePrivateKey`). Returns the raw 64-byte signature; the caller
 * base64(url)-encodes it for the wire. Authorizes deleting (this device, this welcome).
 */
export function signWelcomeConsume(
  signaturePrivateKey: Uint8Array,
  deviceId: string,
  welcomeId: string,
): Uint8Array {
  return sign('consume', signaturePrivateKey, deviceId, welcomeId);
}

/** Verify a CONSUME proof against the device's PUBLIC signature key (key directory). Total (never throws). */
export function verifyWelcomeConsume(
  signaturePublicKey: Uint8Array,
  deviceId: string,
  welcomeId: string,
  signature: Uint8Array,
): boolean {
  return verify('consume', signaturePublicKey, deviceId, welcomeId, signature);
}

/**
 * Sign a FETCH proof with the device's signature private key. Authorizes retrieving (this device, this
 * welcome)'s sealed blobs. Distinct domain from consume — a fetch proof can't delete.
 */
export function signWelcomeFetch(
  signaturePrivateKey: Uint8Array,
  deviceId: string,
  welcomeId: string,
): Uint8Array {
  return sign('fetch', signaturePrivateKey, deviceId, welcomeId);
}

/** Verify a FETCH proof against the device's PUBLIC signature key (key directory). Total (never throws). */
export function verifyWelcomeFetch(
  signaturePublicKey: Uint8Array,
  deviceId: string,
  welcomeId: string,
  signature: Uint8Array,
): boolean {
  return verify('fetch', signaturePublicKey, deviceId, welcomeId, signature);
}

/**
 * Generate an Ed25519 signature keypair (CSPRNG via @noble). PRODUCTION device keys come from MLS
 * (`MlsEngine.generateDeviceKeys` — use `privatePackage.signaturePrivateKey` /
 * `publicPackage.leafNode.signaturePublicKey`); this standalone keygen exists for proof-context tests
 * and tooling that must not pull the MLS WASM.
 */
export function generateSignatureKeypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = ed25519.utils.randomSecretKey();
  return { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
}
