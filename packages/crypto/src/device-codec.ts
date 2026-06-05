import type { DeviceKeys } from './index.js';

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

/**
 * Serialize DeviceKeys to bytes (for sealing / backup). Inverse of `deserializeDeviceKeys`.
 * ⚠️ Output is UNSEALED secret key material — seal it immediately (`sealBackup`); never persist or
 * transmit the raw bytes.
 */
export function serializeDeviceKeys(keys: DeviceKeys): Uint8Array {
  return te.encode(
    JSON.stringify(keys, (_k, v: unknown) =>
      v instanceof Uint8Array
        ? { __u8: toB64(v) }
        : typeof v === 'bigint'
          ? { __bi: v.toString() }
          : v,
    ),
  );
}

/** Reconstruct DeviceKeys from `serializeDeviceKeys` output. */
export function deserializeDeviceKeys(bytes: Uint8Array): DeviceKeys {
  return JSON.parse(td.decode(bytes), (_k, v: unknown) => {
    if (v && typeof v === 'object') {
      const tagged = v as { __u8?: unknown; __bi?: unknown };
      if (typeof tagged.__u8 === 'string') return fromB64(tagged.__u8);
      if (typeof tagged.__bi === 'string') return BigInt(tagged.__bi);
    }
    return v;
  }) as DeviceKeys;
}
