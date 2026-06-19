// Service-worker subresource-integrity enforcement (CDI-1).
//
// The service worker re-hashes each same-origin built asset it serves and refuses to deliver one whose
// SHA-384 doesn't match the build-time manifest baked into sw.js. This closes the gap that native dynamic
// import() leaves open: the ts-mls crypto chunks (nist-*, ed448-*, chacha-*, ml-dsa-*, ml-kem-*, …) load
// via import() and CANNOT carry an SRI integrity= attribute (a browser-platform gap), so a chunk swapped on
// the CDN/cache leg would otherwise run INSIDE the crypto boundary. The <script>/<link> tags in index.html
// are already SRI-protected (vite-plugin-sri3); this covers the dynamic-import chunks they can't.
// See docs/threat-models/code-delivery-integrity.md.
//
// These helpers are pure and DOM-free so they unit-test without a real ServiceWorkerGlobalScope.

/**
 * Manifest key for a request URL path: the dist-relative asset path (no leading slash), or null when the
 * path can't be an asset key. Manifest keys look like "assets/nist-D6IHJPI4.js"; requests arrive as
 * "/assets/nist-D6IHJPI4.js".
 */
export function integrityManifestKey(pathname: string): string | null {
  const key = pathname.replace(/^\/+/, '');
  return key.length > 0 ? key : null;
}

/** Base64 of the SHA-384 over `bytes` — the exact encoding bundle-manifest.json and the SRI attrs use. */
export async function sha384Base64(bytes: ArrayBuffer): Promise<string> {
  // This is a CHECKSUM over PUBLIC static build artifacts (the same sha384 the SRI integrity= attrs and
  // bundle-manifest.json carry), NOT message/key crypto and NOT a protocol. Per
  // docs/threat-models/code-delivery-integrity.md §4 / review 01-crypto-core.md:50 the SHA-384 build-SRI use
  // is pre-cleared as a non-E2EE primitive. No keys, plaintext, or secrets touch it.
  const digest = await crypto.subtle.digest('SHA-384', bytes); // nosemgrep: argus-crypto-only-in-crypto-package

  let bin = '';
  for (const byte of new Uint8Array(digest)) bin += String.fromCharCode(byte);
  return btoa(bin);
}

export interface IntegrityDecision {
  /** True when the request path is in the manifest and therefore subject to integrity enforcement. */
  guarded: boolean;
  /** True when the asset may be served: unguarded paths always pass; guarded ones only on a hash match. */
  ok: boolean;
}

/**
 * Decide whether a fetched asset may be served.
 *
 * `expected` is the manifest hash for the request's key, or undefined when the path is not in the manifest.
 * An UNKNOWN path passes through untouched ({guarded:false, ok:true}) — this is mandatory: it is what keeps
 * a mid-deploy version skew from bricking the app. A newly deployed build's chunks have fresh content-hashed
 * names that are simply absent from an already-installed (old) SW's manifest, so they fall through to the
 * network instead of being falsely rejected. Tightening this to "block any /assets/* not in the manifest"
 * would brick every deploy.
 *
 * A KNOWN path fails closed on any mismatch ({guarded:true, ok:false}) — the SW then refuses to serve the
 * bytes, the dynamic import() rejects, and the crypto operation errors out rather than running tampered code.
 */
export async function checkAssetIntegrity(
  expected: string | undefined,
  bytes: ArrayBuffer,
): Promise<IntegrityDecision> {
  if (!expected) return { guarded: false, ok: true };
  const actual = await sha384Base64(bytes);
  return { guarded: true, ok: actual === expected };
}
