import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { DeviceKeys } from '@argus/crypto';
import {
  deviceSignaturePublicKeyB64,
  deviceSignatureSeed,
  formatDeviceIdentity,
  parseDeviceIdentity,
} from '@argus/crypto';

import { signWithdraw } from '@argus/crypto/device-proof';
import { migrateDevice } from '../../lib/api';
import { DeviceKeystore } from '../../lib/keystore';
import { deriveUnlockKeyViaAssertion, takeUnlockKey } from '../../lib/prf';
import { provisionDevice } from '../../lib/provisioning';
import { useAuth } from '../auth/AuthContext';

// Holds the SESSION's unlocked MLS device + its one-time KeyPackage pool. The device is sealed at rest under
// the passkey-PRF UNLOCK KEY (a per-passkey hmac-secret output imported as a non-extractable AES-GCM key —
// see lib/prf.ts). Unlock is automatic: the login/registration ceremony hands the unlock key to the keystore
// (no separate prompt); on reload — when the session was restored from the refresh cookie with no ceremony —
// the gate runs ONE fresh assertion to re-derive it. There is NO passphrase and NO recovery: a lost passkey
// is a fresh start (the admin mints a new registration code). The breakglass/metadata-only admin has no MLS
// device at all and skips the gate. Demo mode (auth unconfigured) is a passthrough — no real device.

export type DeviceStatus =
  | 'loading' // opening the keystore
  | 'needs-create' // first run on this profile — create + seal under the passkey
  | 'needs-unlock' // a sealed device exists for THIS account — open it with the passkey
  | 'needs-switch' // a device for a DIFFERENT account is on this browser (single slot) — reset to continue
  | 'needs-confirm-reset' // orphaned encrypted data detected — user must confirm fresh start
  | 'unlocking' // opening + provisioning
  | 'ready' // unlocked + pool published (or breakglass / demo passthrough)
  | 'error'; // no PRF on this authenticator → fresh-start required

/**
 * Map the browser's single device slot to a gate status for the signed-in user — keyed by IDENTITY, not
 * mere presence. No stored device → first-run create; same identity → unlock; a DIFFERENT account's device
 * holds the slot → switch/reset (v1 is one device per browser). Used for both initial detection and the
 * post-failure fallback, so neither path strands a user behind another account's device.
 */
function statusForStored(stored: string | undefined, userId: string): DeviceStatus {
  if (!stored) return 'needs-create';
  const { userId: storedUserId } = parseDeviceIdentity(stored);
  // Legacy pre-B2 format (no deviceUuid): storedUserId still matches the current user, so fall through
  // to 'needs-unlock'. The unlock() callback detects the missing deviceUuid and upgrades to composite
  // identity automatically. Only a genuinely different storedUserId reaches 'needs-switch'.
  return storedUserId === userId ? 'needs-unlock' : 'needs-switch';
}

interface DeviceState {
  device: DeviceKeys | null;
  /** The one-time KeyPackage pool (privates retained for join). */
  pool: DeviceKeys[] | null;
  /** This device's server id (from provisioning) — needed to list/fetch/consume Welcomes (Slice 4). */
  deviceId: string | null;
  /** True until this device is approved by an existing trusted device. */
  deviceIsProvisional: boolean | null;
  /** The per-device UUID component of the composite MLS identity (userId:deviceUuid). Used by B2 enrollment. */
  deviceUuid: string | null;
  keystore: DeviceKeystore | null;
  /**
   * The per-unlock passkey-PRF AES-256-GCM key. In memory only — non-extractable, never persisted; cleared on
   * reset. It seals the device + pool at rest AND the per-conversation group state / message history (cheap
   * AES-GCM, no per-message KDF). Exposed as `sessionKey` for the messaging layer.
   */
  sessionKey: CryptoKey | null;
  status: DeviceStatus;
  error: string | null;
  /**
   * Unlock (or create on first run) the device, then provision + publish its KeyPackage pool. The unlock key
   * comes from the login/registration ceremony when available, otherwise from a fresh passkey assertion
   * (needs a user gesture — the gate calls this from a click on reload).
   */
  unlock: () => Promise<void>;
  /**
   * Clear a DIFFERENT account's device occupying this browser's single slot, then set up the signed-in
   * account fresh. The replaced account starts fresh on this browser (single-device v1; there is no recovery
   * — a lost passkey means the admin mints a new registration code).
   */
  resetForNewAccount: () => Promise<void>;
  /**
   * Confirm a fresh-start after the `'needs-confirm-reset'` warning: wipe orphaned data and
   * proceed to create a new device. Only meaningful in that state; a no-op otherwise.
   */
  confirmReset: () => Promise<void>;
  /** Mark this local device as trusted after the server-approved enrollment event reaches this PWA. */
  markDeviceTrusted: () => void;
}

const DeviceCtx = createContext<DeviceState | null>(null);

export function DeviceProvider({ children }: { children: ReactNode }): ReactNode {
  const { demoMode, profile } = useAuth();
  const configured = !demoMode;
  const [keystore, setKeystore] = useState<DeviceKeystore | null>(null);
  const [device, setDevice] = useState<DeviceKeys | null>(null);
  const [pool, setPool] = useState<DeviceKeys[] | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [deviceIsProvisional, setDeviceIsProvisional] = useState<boolean | null>(null);
  const [deviceUuid, setDeviceUuid] = useState<string | null>(null);
  const [sessionKey, setSessionKey] = useState<CryptoKey | null>(null);
  // Demo mode has no real device — render the chat (seed-driven) without a gate.
  const [status, setStatus] = useState<DeviceStatus>(configured ? 'loading' : 'ready');
  const [error, setError] = useState<string | null>(null);
  // Stash the derived unlock key across the 'needs-confirm-reset' pause so the user's passkey
  // assertion doesn't need to be repeated after they confirm the fresh start.
  const pendingUnlockKeyForReset = useRef<{
    key: CryptoKey;
    identity: string;
    uuid: string;
  } | null>(null);
  // After clearDevice()+getOrCreateDevice() succeeds but provisionDevice() fails, store the created
  // device here so a retry can skip the destructive clear phase and only retry provisioning.
  // Without this, a retry after a partial provisioning failure would wipe the newly-created device's
  // private keys even if the key packages were already published to the server.
  const pendingResetDevice = useRef<DeviceKeys | null>(null);

  // The breakglass/metadata-only admin has no MLS device and no keystore — it never touches message content,
  // so it skips the gate entirely (ChatScreen is null-device-tolerant; new conversations are hidden).
  const isBreakglass = profile?.isBreakglass === true;

  useEffect(() => {
    if (!configured) return; // demo: no keystore, no provisioning
    if (isBreakglass) {
      setStatus('ready'); // admin: no device, no keystore, no content path
      return;
    }
    let active = true;
    void (async () => {
      try {
        const ks = keystore ?? (await DeviceKeystore.open());
        if (!active) return;
        if (!keystore) setKeystore(ks);
        const stored = await ks.storedIdentity(); // plaintext identity, no unlock
        if (!active) return;
        setStatus((prev) => {
          if (prev === 'unlocking' || prev === 'ready') return prev; // don't interrupt an active flow
          if (!profile) return 'loading'; // wait until we know which account is signing in
          return statusForStored(stored, profile.userId);
        });
      } catch {
        if (active) {
          setError('could not open the local keystore');
          setStatus('error');
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [configured, isBreakglass, profile, keystore]);

  const unlock = useCallback(async (): Promise<void> => {
    if (!keystore) return;
    if (!profile) {
      setError('still loading your profile — try again in a moment');
      return;
    }
    const userId = profile.userId;
    setStatus('unlocking');
    setError(null);

    // Obtain the passkey-PRF unlock key: handed over by the login/registration ceremony, or derived now via a
    // fresh assertion (e.g. a reload restored the session from cookie with no ceremony). The assertion needs a
    // user gesture — the gate only auto-runs unlock() when a key was already stashed, otherwise on a click.
    let unlockKey: CryptoKey | null;
    try {
      unlockKey = takeUnlockKey() ?? (await deriveUnlockKeyViaAssertion());
    } catch (err) {
      // User cancelled the passkey prompt / no credential available — let them retry the gate.
      setError(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Unlock cancelled. Try again.'
          : 'Could not access your passkey. Try again.',
      );
      setStatus(statusForStored(await keystore.storedIdentity(), userId));
      return;
    }
    if (!unlockKey) {
      // The ceremony completed but this authenticator returned no PRF output — there is no path to the
      // keystore key, and there is no recovery. Fresh start: the admin mints a new registration code.
      setError(
        'This device can’t unlock with your passkey. Ask your admin for a new registration code to start fresh.',
      );
      setStatus('error');
      return;
    }

    try {
      const storedIdent = await keystore.storedIdentity();
      const parsed = storedIdent ? parseDeviceIdentity(storedIdent) : null;
      // Pre-B2 devices have a bare userId identity (no deviceUuid). Same user → migrate to composite
      // identity: open the old sealed record, clear it, then create fresh.
      const isLegacyMigration =
        parsed !== null && parsed.deviceUuid === undefined && parsed.userId === userId;
      // Create if: first run or a different user's device occupies the slot.
      const creating = !parsed || parsed.userId !== userId;
      let identity: string;
      let uuid: string;
      if (creating || isLegacyMigration) {
        uuid = crypto.randomUUID();
        identity = formatDeviceIdentity(userId, uuid);
      } else {
        identity = storedIdent!;
        uuid = parsed.deviceUuid!;
      }
      let dev: DeviceKeys | undefined;
      if (isLegacyMigration) {
        // Atomically migrate the old device to composite identity: migrateDevice deletes the old
        // row and re-inserts it as isProvisional=false in one transaction, eliminating the race
        // window that separate withdrawDevice + provisionDevice calls leave open.
        const oldDev = await keystore.loadDevice(storedIdent!, unlockKey);
        if (!oldDev) throw new Error('legacy device not found in keystore');
        const oldSpk = deviceSignaturePublicKeyB64(oldDev);
        const proofBytes = signWithdraw(deviceSignatureSeed(oldDev), oldSpk);
        const proof = btoa(String.fromCharCode(...proofBytes))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
        await migrateDevice(oldSpk, proof);
        // Reidentify: preserve the signing key under the new composite identity so existing
        // MLS group states (which embed the private key internally) remain usable. Only the
        // identity string metadata guards change — the ratchet and leaf-node key are the same.
        dev = await keystore.reidentifyDevice(storedIdent!, identity, unlockKey);
        await keystore.clearPoolAndPending(); // old key packages are stale after server withdraw
        await keystore.rebindGroupStates(dev); // update GROUP_STORE identity guards
        await keystore.rebindMessageLogs(dev); // update MSGLOG identity guards
      } else if (creating) {
        // Before silently creating a new device, check if orphaned encrypted data survives from a
        // prior device (e.g. after browser storage eviction cleared only the STORE entry). Creating
        // a new device would make that data permanently inaccessible — the identity guard wouldn't
        // match. Pause in 'needs-confirm-reset' so the user can acknowledge the data loss.
        if (await keystore.hasOrphanedData(identity)) {
          pendingUnlockKeyForReset.current = { key: unlockKey, identity, uuid };
          setStatus('needs-confirm-reset');
          return;
        }
        dev = await keystore.getOrCreateDevice(identity, unlockKey);
      } else {
        dev = await keystore.loadDevice(identity, unlockKey);
      }
      if (!dev) throw new Error('no device found to unlock');
      const { pool: provisioned, result } = await provisionDevice(keystore, dev, unlockKey);
      setDevice(dev);
      setPool(provisioned);
      setDeviceId(result.deviceId);
      setDeviceIsProvisional(result.isProvisional);
      setDeviceUuid(uuid);
      setSessionKey(unlockKey); // seals the device/pool + per-conversation state (memory only)
      setStatus('ready');
    } catch {
      // open fails closed on a wrong unlock key (GCM auth) — shouldn't happen for the right passkey, but a
      // keystore sealed under a different passkey on this browser would land here. Surface generically.
      setError('could not unlock the device');
      setStatus(statusForStored(await keystore.storedIdentity(), userId));
    }
  }, [keystore, profile]);

  const resetForNewAccount = useCallback(async (): Promise<void> => {
    if (!keystore) return;
    await keystore.clearDevice(); // wipes the other account's device + pool from this browser's single slot
    setSessionKey(null);
    setDeviceIsProvisional(null);
    setError(null);
    setStatus('needs-create');
  }, [keystore]);

  // Called when the user explicitly confirms a fresh start after seeing the 'needs-confirm-reset'
  // warning. Wipes orphaned data, then proceeds to create the new device using the unlock key that
  // was already derived during the interrupted unlock() call — no second passkey tap required.
  //
  // Retry-safe: clearDevice()+getOrCreateDevice() only run on the first attempt. If provisionDevice()
  // fails (e.g. network error after key packages are published), the created device is stashed in
  // pendingResetDevice so retries skip the destructive clear and only retry provisioning. Without this,
  // a retry would wipe the private keys for already-published key packages, making them unresolvable.
  const confirmReset = useCallback(async (): Promise<void> => {
    if (!keystore || status !== 'needs-confirm-reset') return;
    const pending = pendingUnlockKeyForReset.current;
    if (!pending) return;
    setStatus('unlocking');
    setError(null);
    try {
      let dev = pendingResetDevice.current;
      if (!dev) {
        // First attempt: wipe all stores including the orphaned data, then create.
        await keystore.clearDevice();
        dev = await keystore.getOrCreateDevice(pending.identity, pending.key);
        if (!dev) throw new Error('no device found after reset');
        // Stash so a provisioning failure doesn't re-run the destructive clear on retry.
        pendingResetDevice.current = dev;
      }
      const { pool: provisioned, result } = await provisionDevice(keystore, dev, pending.key);
      // Clear both refs only on full success.
      pendingUnlockKeyForReset.current = null;
      pendingResetDevice.current = null;
      setDevice(dev);
      setPool(provisioned);
      setDeviceId(result.deviceId);
      setDeviceIsProvisional(result.isProvisional);
      setDeviceUuid(pending.uuid);
      setSessionKey(pending.key);
      setStatus('ready');
    } catch {
      setError('could not set up the device — try again');
      setStatus('needs-confirm-reset'); // pending key + created device (if any) still available for retry
    }
  }, [keystore, status]);

  const markDeviceTrusted = useCallback(() => {
    setDeviceIsProvisional((current) => (current === true ? false : current));
  }, []);

  const value: DeviceState = {
    device,
    pool,
    deviceId,
    deviceIsProvisional,
    deviceUuid,
    keystore,
    sessionKey,
    status,
    error,
    unlock,
    resetForNewAccount,
    confirmReset,
    markDeviceTrusted,
  };
  return <DeviceCtx.Provider value={value}>{children}</DeviceCtx.Provider>;
}

export function useDevice(): DeviceState {
  const ctx = useContext(DeviceCtx);
  if (!ctx) throw new Error('useDevice must be used within <DeviceProvider>');
  return ctx;
}
