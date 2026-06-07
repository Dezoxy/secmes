import type { RatchetTree, Welcome } from 'ts-mls';

import type { ConversationInvite, DeviceIdentity, DeviceKeys, KeyPackage } from './index.js';

// Fidelity-preserving codec for DeviceKeys → bytes (sealBackup needs a Uint8Array; IndexedDB's native
// structured clone can't produce bytes). ts-mls key objects contain Uint8Array AND bigint, so JSON
// alone is insufficient — encode both explicitly. Pure data only (no functions/Maps), verified by the
// round-trip test.
const te = new TextEncoder();
const td = new TextDecoder();

function toB64(u: Uint8Array): string {
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// ts-mls key objects mix Uint8Array + bigint, which JSON can't represent — tag both explicitly. Shared
// by the single- and array-valued codecs so they stay byte-compatible.
function taggedReplacer(_k: string, v: unknown): unknown {
  if (v instanceof Uint8Array) return { __u8: toB64(v) };
  if (typeof v === 'bigint') return { __bi: v.toString() };
  return v;
}
function taggedReviver(_k: string, v: unknown): unknown {
  if (v && typeof v === 'object') {
    const tagged = v as { __u8?: unknown; __bi?: unknown };
    if (typeof tagged.__u8 === 'string') return fromB64(tagged.__u8);
    if (typeof tagged.__bi === 'string') return BigInt(tagged.__bi);
  }
  return v;
}

/**
 * Serialize DeviceKeys to bytes (for sealing / backup). Inverse of `deserializeDeviceKeys`.
 * ⚠️ Output is UNSEALED secret key material — seal it immediately (`sealBackup`); never persist or
 * transmit the raw bytes.
 */
export function serializeDeviceKeys(keys: DeviceKeys): Uint8Array {
  return te.encode(JSON.stringify(keys, taggedReplacer));
}

/** Reconstruct DeviceKeys from `serializeDeviceKeys` output. */
export function deserializeDeviceKeys(bytes: Uint8Array): DeviceKeys {
  return JSON.parse(td.decode(bytes), taggedReviver) as DeviceKeys;
}

/**
 * Serialize an ARRAY of DeviceKeys to bytes — for sealing the one-time KeyPackage POOL (device
 * provisioning, Slice 2). Inverse of `deserializeDeviceKeysArray`. ⚠️ UNSEALED secret key material —
 * seal it immediately; never persist or transmit the raw bytes.
 */
export function serializeDeviceKeysArray(pool: DeviceKeys[]): Uint8Array {
  return te.encode(JSON.stringify(pool, taggedReplacer));
}

/** Reconstruct a DeviceKeys[] pool from `serializeDeviceKeysArray` output. Throws if not an array. */
export function deserializeDeviceKeysArray(bytes: Uint8Array): DeviceKeys[] {
  const parsed = JSON.parse(td.decode(bytes), taggedReviver) as unknown;
  if (!Array.isArray(parsed)) throw new Error('malformed device-keys pool (not an array)');
  return parsed as DeviceKeys[];
}

/**
 * Serialize a device's PUBLIC KeyPackage to base64 — the publishable wire form the key directory (#19)
 * stores and a peer claims. PUBLIC material only (no private keys). Uses the same tagged JSON codec as
 * DeviceKeys (faithfully preserves Uint8Array/bigint), so a round-tripped KeyPackage re-encodes to the
 * same MLS bytes — ts-mls computes an identical key_package_ref, so `addMember` and the recipient's
 * join-time match still line up. Inverse of `deserializeKeyPackage`.
 */
export function serializeKeyPackage(pkg: KeyPackage): string {
  return toB64(te.encode(JSON.stringify(pkg, taggedReplacer)));
}

/** Parse a base64 wire KeyPackage (e.g. one claimed from the directory) back to a KeyPackage. */
export function deserializeKeyPackage(b64: string): KeyPackage {
  return JSON.parse(td.decode(fromB64(b64)), taggedReviver) as KeyPackage;
}

/**
 * Base64 of a device's STABLE signature public key — the identity the key directory registers the device
 * under, and the binding for the device's sealed KeyPackage pool. PUBLIC material only.
 */
export function deviceSignaturePublicKeyB64(device: DeviceKeys): string {
  return toB64(device.publicPackage.leafNode.signaturePublicKey);
}

/**
 * The deliverable wire form of a {@link ConversationInvite} (Welcome + RatchetTree). Each field is the
 * tagged-JSON base64 of the corresponding ts-mls object (the same codec as KeyPackage, faithfully
 * preserving Uint8Array/bigint), so a round-tripped invite reconstructs an identical object for
 * `joinConversation`. The two fields map 1:1 onto the welcomes endpoint body (`welcome` + `ratchetTree`,
 * each base64). Opaque to the crypto-blind server — the Welcome is HPKE-sealed to the recipient's claimed
 * KeyPackage; only the recipient's retained private can open it.
 */
export interface SerializedInvite {
  welcome: string;
  ratchetTree: string;
}

/** Serialize a {@link ConversationInvite} to the base64 wire form delivered to the directory. */
export function serializeInvite(invite: ConversationInvite): SerializedInvite {
  // A RatchetTree is `(Node | undefined)[]`: its BLANK nodes are `undefined`, which JSON.stringify would
  // silently turn into `null` and corrupt — ts-mls then fails parent-hash validation on join. Map blanks
  // to `null` explicitly here and back to `undefined` in `deserializeInvite`; Node internals (Uint8Array /
  // bigint) ride the shared tagged codec. (ts-mls' own TLS encoders are reachable only via a deep subpath,
  // not the barrel — so this mirrors the existing KeyPackage codec for consistency.)
  return {
    welcome: toB64(te.encode(JSON.stringify(invite.welcome, taggedReplacer))),
    ratchetTree: toB64(
      te.encode(
        JSON.stringify(
          invite.ratchetTree.map((n) => n ?? null),
          taggedReplacer,
        ),
      ),
    ),
  };
}

/** Reconstruct a {@link ConversationInvite} from its base64 wire form (the fetched Welcome material). */
export function deserializeInvite(s: SerializedInvite): ConversationInvite {
  const tree = JSON.parse(td.decode(fromB64(s.ratchetTree)), taggedReviver) as unknown[];
  return {
    welcome: JSON.parse(td.decode(fromB64(s.welcome)), taggedReviver) as Welcome,
    ratchetTree: tree.map((n) => (n == null ? undefined : n)) as RatchetTree,
  };
}

/**
 * Serialize identity-only recovery material to bytes (for sealing as a backup; key-backup.md §4).
 * Carries the signing identity only — NO one-time KeyPackage HPKE private keys. Inverse of
 * `deserializeDeviceIdentity`. ⚠️ Output contains the secret signing key — seal it immediately.
 */
export function serializeDeviceIdentity(id: DeviceIdentity): Uint8Array {
  return te.encode(
    JSON.stringify({
      identity: id.identity,
      spk: toB64(id.signaturePublicKey),
      ssk: toB64(id.signaturePrivateKey),
    }),
  );
}

/** Reconstruct DeviceIdentity from `serializeDeviceIdentity` output. Throws on a malformed blob. */
export function deserializeDeviceIdentity(bytes: Uint8Array): DeviceIdentity {
  const o = JSON.parse(td.decode(bytes)) as Record<string, unknown>;
  if (typeof o.identity !== 'string' || typeof o.spk !== 'string' || typeof o.ssk !== 'string') {
    throw new Error('malformed device identity');
  }
  return {
    identity: o.identity,
    signaturePublicKey: fromB64(o.spk),
    signaturePrivateKey: fromB64(o.ssk),
  };
}
