import { argon2id } from '@noble/hashes/argon2.js';

// Passphrase-sealed backup of private key material: Argon2id (memory-hard KDF) → AES-256-GCM.
// Used to back up a device's IDENTITY keys for recovery, and to seal the keystore at rest. Argon2id
// + WebCrypto AES-GCM are audited primitives (not hand-rolled); this is the sanctioned crypto package.
// See docs/threat-models/key-backup.md.

export interface Argon2Params {
  /** memory cost in KiB */
  m: number;
  /** time cost (iterations) */
  t: number;
  /** parallelism */
  p: number;
}

/** Production parameters (key-backup.md): 64 MiB, 3 passes, 1 lane. */
export const DEFAULT_ARGON2: Argon2Params = { m: 65536, t: 3, p: 1 };

// Hard floor: refuse to seal OR open below this, so a misconfigured caller can't create a weak
// backup and a tampered/downgraded server-stored blob is rejected before we even derive.
// (Tampering params also changes the derived key → GCM would fail anyway; this fails fast + loud.)
const MIN_ARGON2: Argon2Params = { m: 8192, t: 2, p: 1 };

function assertStrong(p: Argon2Params): void {
  if (p.m < MIN_ARGON2.m || p.t < MIN_ARGON2.t || p.p < MIN_ARGON2.p) {
    throw new Error('Argon2id parameters are below the minimum security floor');
  }
}

export interface SealedBackup {
  v: 1;
  kdf: 'argon2id';
  params: Argon2Params;
  salt: string; // base64, 16 bytes (unique per seal)
  iv: string; // base64, 12-byte AES-GCM nonce (unique per seal)
  ciphertext: string; // base64 AES-256-GCM output (includes the auth tag)
}

const te = new TextEncoder();

function toB64(u: Uint8Array): string {
  let s = '';
  for (const byte of u) s += String.fromCharCode(byte);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** Re-pack into a fresh ArrayBuffer-backed view — WebCrypto's BufferSource needs ArrayBuffer, not ArrayBufferLike. */
function bytes(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(u.byteLength);
  copy.set(u);
  return copy;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  params: Argon2Params,
  usage: KeyUsage[],
): Promise<CryptoKey> {
  const raw = argon2id(te.encode(passphrase), salt, {
    t: params.t,
    m: params.m,
    p: params.p,
    dkLen: 32,
  });
  const packed = bytes(raw);
  const key = await crypto.subtle.importKey('raw', packed, 'AES-GCM', false, usage);
  raw.fill(0); // best-effort wipe of the derived key bytes (matches the package's wipe() discipline)
  packed.fill(0);
  return key;
}

/** Encrypt private key material under a passphrase-derived key. Fresh salt + IV every call. */
export async function sealBackup(
  plaintext: Uint8Array,
  passphrase: string,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<SealedBackup> {
  assertStrong(params);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, params, ['encrypt']);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bytes(iv) }, key, bytes(plaintext)),
  );
  return { v: 1, kdf: 'argon2id', params, salt: toB64(salt), iv: toB64(iv), ciphertext: toB64(ct) };
}

/** Decrypt a SealedBackup. Throws on a wrong passphrase or any tampering (AES-GCM auth failure). */
export async function openBackup(backup: SealedBackup, passphrase: string): Promise<Uint8Array> {
  assertStrong(backup.params); // reject a downgraded/weak blob before spending the KDF
  const salt = fromB64(backup.salt);
  const iv = fromB64(backup.iv);
  if (salt.length !== 16 || iv.length !== 12) throw new Error('malformed backup blob');
  const key = await deriveKey(passphrase, salt, backup.params, ['decrypt']);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(iv) },
      key,
      bytes(fromB64(backup.ciphertext)),
    );
    return new Uint8Array(pt);
  } catch {
    throw new Error('backup decryption failed (wrong passphrase or tampered data)');
  }
}
