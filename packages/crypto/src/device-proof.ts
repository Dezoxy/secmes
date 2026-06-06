// Device proof-of-possession for welcome consume (welcome-delivery.md). The access token proves the
// USER (`sub`), not which DEVICE a session is. A pending MLS Welcome is HPKE-sealed to ONE device's
// claimed KeyPackage; to consume (delete) it, the caller proves possession of THAT device's Ed25519
// signature private key by signing a domain-separated message. The crypto-blind server verifies the
// proof against the device's PUBLIC signature key (published in the key directory) — an authentication
// check over public keys, never content decryption (invariant #1 holds).
//
// Ed25519 via @noble/curves is an audited primitive (the device's MLS signature scheme for the v1
// suite), not hand-rolled. This module deliberately imports NO ts-mls, so the server can verify proofs
// without loading the MLS WASM. See the `./device-proof` package export.
import { ed25519 } from '@noble/curves/ed25519.js';

const te = new TextEncoder();

// Domain-separated so this app-level proof signature can never collide with an MLS protocol signature
// over the same key (cross-protocol confusion). Binds the purpose + the specific device + the welcome.
const PROOF_DOMAIN = 'argus-welcome-consume:v1';

function consumeProofMessage(deviceId: string, welcomeId: string): Uint8Array {
  return te.encode(`${PROOF_DOMAIN}\n${deviceId}\n${welcomeId}`);
}

/**
 * Sign a welcome-consume proof with the DEVICE's Ed25519 signature private key
 * (`DeviceKeys.privatePackage.signaturePrivateKey`). Returns the raw 64-byte signature; the caller
 * base64(url)-encodes it for the wire. Binds the proof to (this device, this welcome).
 */
export function signWelcomeConsume(
  signaturePrivateKey: Uint8Array,
  deviceId: string,
  welcomeId: string,
): Uint8Array {
  return ed25519.sign(consumeProofMessage(deviceId, welcomeId), signaturePrivateKey);
}

/**
 * Verify a welcome-consume proof against the device's PUBLIC signature key (the key directory's
 * `signature_public_key`). Returns false (never throws) on a forged / tampered / malformed proof — a
 * sibling device of the same user, lacking this device's private key, cannot produce a valid proof.
 */
export function verifyWelcomeConsume(
  signaturePublicKey: Uint8Array,
  deviceId: string,
  welcomeId: string,
  signature: Uint8Array,
): boolean {
  try {
    // Signature non-malleability is intentionally NOT relied upon here: anti-replay comes from the
    // fresh random `welcomeId` (the row is deleted on first consume), not from the signature bytes —
    // so the proof must never be repurposed as a dedup/idempotency token. Returns false (never throws)
    // on a forged / tampered / malformed proof or key, so callers map any failure to one opaque 404.
    return ed25519.verify(signature, consumeProofMessage(deviceId, welcomeId), signaturePublicKey);
  } catch {
    return false;
  }
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
