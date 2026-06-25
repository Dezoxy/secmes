// TURN ephemeral credential generation — cross-platform (browser + Node 18+).
// Follows the TURN REST API convention implemented by coturn's `use-auth-secret` mode:
//   username  = "<unix-expiry>:<userId>"
//   credential = base64( HMAC-SHA1( username, staticAuthSecret ) )
// Reference: TURN REST API draft (Uberti, IETF behave WG, 2013).
//
// HMAC-SHA1 is mandated by the coturn wire protocol — not a security choice. The algorithm is
// specified by the TURN REST API draft; coturn's `use-auth-secret` verifies exactly this form.
// Uses WebCrypto (crypto.subtle) so the file stays compatible with the package's DOM lib target.
// The output is SECRET-EQUIVALENT and must never be logged or persisted.

const enc = new TextEncoder();

function toBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

/**
 * Mint a coturn-compatible ephemeral TURN credential (async, WebCrypto).
 *
 * @param username  The cleartext username string (`"<expiry>:<userId>"`). Already computed by caller.
 * @param hmacKey   The `static-auth-secret` loaded from Key Vault. SECRET-EQUIVALENT — never log.
 * @returns base64-encoded HMAC-SHA1 digest (the `credential` field in the ICE server config).
 */
export async function mintTurnCredential(username: string, hmacKey: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(hmacKey),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(username));
  return toBase64(sig);
}
