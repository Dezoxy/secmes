import { argon2idAsync } from '@noble/hashes/argon2.js';

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

// Bound Argon2id params on both ends. Floor: a misconfigured caller can't make a weak backup and a
// downgraded server blob is rejected before we derive. Ceiling: kept budget-phone-safe so a tampered
// server blob can't force a huge allocation before AES-GCM auth fails (DoS). Headroom above DEFAULT
// for a future cost bump; raising DEFAULT past this needs a deliberate ceiling raise + migration.
const MIN_ARGON2: Argon2Params = { m: 8192, t: 2, p: 1 };
const MAX_ARGON2: Argon2Params = { m: 131072, t: 4, p: 2 }; // 128 MiB / 4 passes / 2 lanes (2× DEFAULT mem)

function assertParams(p: Argon2Params): void {
  if (!Number.isInteger(p.m) || !Number.isInteger(p.t) || !Number.isInteger(p.p)) {
    throw new Error('Argon2id parameters must be integers');
  }
  if (p.m < MIN_ARGON2.m || p.t < MIN_ARGON2.t || p.p < MIN_ARGON2.p) {
    throw new Error('Argon2id parameters are below the minimum security floor');
  }
  if (p.m > MAX_ARGON2.m || p.t > MAX_ARGON2.t || p.p > MAX_ARGON2.p) {
    throw new Error('Argon2id parameters exceed the allowed maximum');
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

/**
 * Canonical header bytes bound into AES-GCM as additionalData. params/salt/iv are already implicitly
 * authenticated (they feed key derivation / the nonce), but v + kdf are not — binding the whole header
 * makes any tamper of the version/algorithm fields fail authentication too (anti-downgrade/confusion).
 */
function headerAAD(
  v: number,
  kdf: string,
  params: Argon2Params,
  salt: string,
  iv: string,
): Uint8Array {
  return te.encode(`argus-backup ${v}|${kdf}|${params.m},${params.t},${params.p}|${salt}|${iv}`);
}

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
  // Async variant yields to the event loop so the 64 MiB KDF doesn't freeze the PWA main thread.
  const raw = await argon2idAsync(te.encode(passphrase), salt, {
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
  assertParams(params);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const saltB64 = toB64(salt);
  const ivB64 = toB64(iv);
  const aad = headerAAD(1, 'argon2id', params, saltB64, ivB64);
  const key = await deriveKey(passphrase, salt, params, ['encrypt']);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: bytes(iv), additionalData: bytes(aad) },
      key,
      bytes(plaintext),
    ),
  );
  return { v: 1, kdf: 'argon2id', params, salt: saltB64, iv: ivB64, ciphertext: toB64(ct) };
}

/** Decrypt a SealedBackup. Throws on a wrong passphrase or any tampering (AES-GCM auth failure). */
export async function openBackup(backup: SealedBackup, passphrase: string): Promise<Uint8Array> {
  assertParams(backup.params); // reject a downgraded/weak blob before spending the KDF
  const salt = fromB64(backup.salt);
  const iv = fromB64(backup.iv);
  if (salt.length !== 16 || iv.length !== 12) throw new Error('malformed backup blob');
  const aad = headerAAD(backup.v, backup.kdf, backup.params, backup.salt, backup.iv);
  const key = await deriveKey(passphrase, salt, backup.params, ['decrypt']);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(iv), additionalData: bytes(aad) },
      key,
      bytes(fromB64(backup.ciphertext)),
    );
    return new Uint8Array(pt);
  } catch {
    throw new Error('backup decryption failed (wrong passphrase or tampered data)');
  }
}

// --- Session-key sealing (cheap per-message AES-GCM) -------------------------------------------------
// `sealBackup`/`openBackup` run a 64 MiB Argon2id on EVERY call — right for a one-shot backup, far too slow
// to seal each message. For data sealed many times per session (the local message-history log) we derive a
// session key ONCE at unlock and reuse it: `deriveSessionKey` pays the KDF; `sealWithKey`/`openWithKey` are
// plain AES-256-GCM. The key is non-extractable and lives in memory only — the caller never persists it.

/** A blob sealed under a session key. Only the (random) IV + ciphertext are stored; the key is not. */
export interface SealedBlob {
  iv: string; // base64, 12-byte AES-GCM nonce — FRESH per seal (never reuse (key, IV))
  ciphertext: string; // base64
}

// Domain separation: a constant AAD so a session-key blob can't be confused with a `sealBackup` blob.
const SESSION_AAD = te.encode('argus-session 1');

// Combine the domain-separation AAD with an optional per-record context (e.g. a conversationId) so a sealed
// blob is bound to its slot — relocating it to another slot fails authentication.
function sessionAad(context?: Uint8Array): Uint8Array {
  if (!context || context.length === 0) return SESSION_AAD;
  const out = new Uint8Array(SESSION_AAD.length + 1 + context.length);
  out.set(SESSION_AAD);
  out[SESSION_AAD.length] = 0x1f; // unit separator between the constant prefix and the context
  out.set(context, SESSION_AAD.length + 1);
  return out;
}

/**
 * Derive a per-session AES-256-GCM key from the passphrase + a STORED per-profile salt (Argon2id). Reuse it
 * for many `sealWithKey`/`openWithKey` calls so per-message persistence is cheap (no per-message KDF). The
 * salt is not secret (stored in the clear); the key is non-extractable and must stay in memory only.
 */
export async function deriveSessionKey(
  passphrase: string,
  salt: Uint8Array,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<CryptoKey> {
  assertParams(params);
  if (salt.length < 16) throw new Error('session-key salt must be at least 16 bytes');
  return deriveKey(passphrase, salt, params, ['encrypt', 'decrypt']);
}

/**
 * Seal bytes under a session key. Fresh CSPRNG IV every call — `(key, IV)` is never reused. `context` binds
 * the blob to its slot (e.g. a conversationId) so it can't be relocated; pass the SAME `context` to open it.
 */
export async function sealWithKey(
  key: CryptoKey,
  plaintext: Uint8Array,
  context?: Uint8Array,
): Promise<SealedBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: bytes(iv), additionalData: bytes(sessionAad(context)) },
      key,
      bytes(plaintext),
    ),
  );
  return { iv: toB64(iv), ciphertext: toB64(ct) };
}

/** Open a session-key-sealed blob (with the same `context` it was sealed under). Throws on a wrong key, a
 * wrong context, or any tampering (AES-GCM auth failure). */
export async function openWithKey(
  key: CryptoKey,
  blob: SealedBlob,
  context?: Uint8Array,
): Promise<Uint8Array> {
  const iv = fromB64(blob.iv);
  if (iv.length !== 12) throw new Error('malformed sealed blob');
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(iv), additionalData: bytes(sessionAad(context)) },
      key,
      bytes(fromB64(blob.ciphertext)),
    );
    return new Uint8Array(pt);
  } catch {
    throw new Error('sealed blob decryption failed (wrong key or tampered data)');
  }
}
