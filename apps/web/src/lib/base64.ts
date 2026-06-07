// Standard (padded) base64 for opaque MLS wire bytes — matches the server's ciphertext contract
// (`^[A-Za-z0-9+/]+={0,2}$`). base64URL (for device proofs, a different alphabet) lives in join.ts; this
// is the message ciphertext path. Bytes only ever hold ciphertext here — never plaintext or key material.

/** Encode raw bytes as standard padded base64. */
export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Decode standard padded base64 back to raw bytes. */
export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
