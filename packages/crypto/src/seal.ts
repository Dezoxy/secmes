// AES-256-GCM sealing utilities. No Argon2 — keys come from WebAuthn PRF (uniformly random 256 bits)
// or from per-attachment CSPRNG. Used by the keystore (PRF unlock key) and attachment encryption.

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

/** A blob sealed under a session key. Only the (random) IV + ciphertext are stored; the key is not. */
export interface SealedBlob {
  iv: string; // base64, 12-byte AES-GCM nonce — FRESH per seal (never reuse (key, IV))
  ciphertext: string; // base64
}

// Domain separation: a constant AAD so a session-key blob can't be confused with any other sealed form.
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
 * Import a raw 32-byte secret as a non-extractable AES-256-GCM `CryptoKey` for `sealWithKey`/`openWithKey`.
 * Used to turn a WebAuthn-PRF output (a per-passkey HMAC secret, high-entropy) directly into the keystore
 * unlock key — the PRF output is already uniformly random 256 bits, so a memory-hard KDF buys nothing.
 * The key is non-extractable and lives in memory only; the caller must wipe the `raw` input after import.
 * Throws if `raw` is not exactly 32 bytes.
 */
export async function importUnlockKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error('unlock key material must be 32 bytes');
  return crypto.subtle.importKey('raw', bytes(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
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

// --- Attachment content-key encryption (E2EE blobs) -------------------------------------------------
// Each attachment gets a FRESH random AES-256-GCM content key. The blob CIPHERTEXT goes to the (untrusted)
// blob store; the raw key + IV ride inside the E2E MLS message envelope, so the server never sees them.
// GCM auth + the per-attachment random key mean a server that swaps the blob can't produce a forgery the
// recipient accepts (decryption fails closed).

export interface EncryptedAttachment {
  /** base64 raw 32-byte content key — wrap in the MLS message envelope ONLY; never send it to the server. */
  key: string;
  /** base64 12-byte AES-GCM IV. */
  iv: string;
  /** the encrypted blob bytes — upload these to the blob store. */
  ciphertext: Uint8Array;
}

// A sanity ceiling so a bug/abuse can't buffer an absurd blob into memory before a clear error. The real
// per-attachment policy cap is enforced upstream — the server upload-grant's `byteSize` and the client's
// pre-encrypt file check.
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024; // 100 MiB

/** Encrypt blob bytes under a FRESH random content key (CSPRNG). Returns the key (for the envelope) + IV + ciphertext. */
export async function encryptAttachment(plaintext: Uint8Array): Promise<EncryptedAttachment> {
  if (plaintext.length > MAX_ATTACHMENT_BYTES) {
    throw new Error('attachment exceeds the maximum encryptable size');
  }
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyBytes = bytes(raw);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  keyBytes.fill(0);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bytes(iv) }, key, bytes(plaintext)),
  );
  const out: EncryptedAttachment = { key: toB64(raw), iv: toB64(iv), ciphertext: ct };
  raw.fill(0);
  return out;
}

/** Decrypt blob ciphertext with the content key + IV unwrapped from the MLS envelope. Throws on a wrong key or tampering. */
export async function decryptAttachment(
  keyB64: string,
  ivB64: string,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const raw = fromB64(keyB64);
  const iv = fromB64(ivB64);
  if (raw.length !== 32) throw new Error('attachment content key must be 32 bytes');
  if (iv.length !== 12) throw new Error('attachment IV must be 12 bytes');
  const keyBytes = bytes(raw);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  keyBytes.fill(0);
  raw.fill(0);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(iv) }, key, bytes(ciphertext)),
    );
  } catch {
    throw new Error('attachment decryption failed (wrong key or tampered data)');
  }
}
