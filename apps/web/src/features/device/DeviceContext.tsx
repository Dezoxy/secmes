import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import type { DeviceKeys } from '@argus/crypto';
import { formatDeviceIdentity, parseDeviceIdentity } from '@argus/crypto';

import { restoreAndProvision } from '../../lib/device-restore';
import { DeviceKeystore } from '../../lib/keystore';
import { provisionDevice } from '../../lib/provisioning';
import { useAuth } from '../auth/AuthContext';

// Holds the SESSION's unlocked MLS device + its one-time KeyPackage pool. The device is sealed at rest
// (Argon2id + AES-GCM); a passphrase unlock (or first-run create) unseals it into memory only, then
// provisions + publishes the pool to the directory (#19). Downstream slices (claim/add/join/send) read
// the unlocked device + pool from here. Demo mode (OIDC unconfigured) is a passthrough — no real device.

export type DeviceStatus =
  | 'loading' // opening the keystore
  | 'needs-create' // first run on this profile — set a passphrase
  | 'needs-unlock' // a sealed device exists for THIS account — enter the passphrase
  | 'needs-switch' // a device for a DIFFERENT account is on this browser (single slot) — reset to continue
  | 'unlocking' // unsealing + provisioning
  | 'ready' // unlocked + pool published (or demo passthrough)
  | 'error';

/**
 * Map the browser's single device slot to a gate status for the signed-in user — keyed by IDENTITY, not
 * mere presence. No stored device → first-run create; same identity → unlock; a DIFFERENT account's device
 * holds the slot → switch/reset (v1 is one device per browser). Used for both initial detection and the
 * post-failure fallback, so neither path strands a user behind another account's device.
 */
function statusForStored(stored: string | undefined, userId: string): DeviceStatus {
  if (!stored) return 'needs-create';
  const { userId: storedUserId, deviceUuid } = parseDeviceIdentity(stored);
  // Legacy format (pre-B2, no deviceUuid): force re-provision so the keystore gets a composite identity.
  if (deviceUuid === undefined) return 'needs-switch';
  return storedUserId === userId ? 'needs-unlock' : 'needs-switch';
}

interface DeviceState {
  device: DeviceKeys | null;
  /** The one-time KeyPackage pool (privates retained for join). */
  pool: DeviceKeys[] | null;
  /** This device's server id (from provisioning) — needed to list/fetch/consume Welcomes (Slice 4). */
  deviceId: string | null;
  /** The per-device UUID component of the composite MLS identity (userId:deviceUuid). Used by B2 enrollment. */
  deviceUuid: string | null;
  keystore: DeviceKeystore | null;
  /**
   * The session passphrase, retained IN MEMORY only — it seals each advanced MLS group state on send/receive
   * (Slice 5). Never persisted, logged, or transmitted. It is no more exposed than the already-unsealed
   * device keys in `device`; a per-unlock derived session key (to avoid per-message Argon2) is the follow-up.
   */
  passphrase: string | null;
  /**
   * The per-unlock AES-256-GCM session key for the local message-history log (derived once from the
   * passphrase + a stored salt). In memory only — never persisted; cleared on reset. Lets per-message
   * history persistence be cheap AES-GCM instead of a per-message Argon2.
   */
  sessionKey: CryptoKey | null;
  status: DeviceStatus;
  error: string | null;
  /** Unlock (or create on first run) the device, then provision + publish its KeyPackage pool. */
  unlock: (passphrase: string) => Promise<void>;
  /**
   * Restore this account's device from a recovery artifact (fresh browser / lost device), then provision.
   * Reachable from the gate BEFORE a device exists — so a lost-device user never has to create a throwaway
   * one first. Updates provider state in place (no reload).
   */
  restore: (artifactJson: string, passphrase: string) => Promise<void>;
  /**
   * Clear a DIFFERENT account's device occupying this browser's single slot, then set up the signed-in
   * account fresh. The replaced account needs its recovery file to use this browser again (single-device
   * v1; multi-account-per-browser is deferred).
   */
  resetForNewAccount: () => Promise<void>;
}

const DeviceCtx = createContext<DeviceState | null>(null);

export function DeviceProvider({ children }: { children: ReactNode }): ReactNode {
  const { configured, profile } = useAuth();
  const [keystore, setKeystore] = useState<DeviceKeystore | null>(null);
  const [device, setDevice] = useState<DeviceKeys | null>(null);
  const [pool, setPool] = useState<DeviceKeys[] | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [deviceUuid, setDeviceUuid] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState<string | null>(null);
  const [sessionKey, setSessionKey] = useState<CryptoKey | null>(null);
  // Demo mode has no real device — render the chat (seed-driven) without a gate.
  const [status, setStatus] = useState<DeviceStatus>(configured ? 'loading' : 'ready');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!configured) return; // demo: no keystore, no provisioning
    let active = true;
    void (async () => {
      try {
        const ks = keystore ?? (await DeviceKeystore.open());
        if (!active) return;
        if (!keystore) setKeystore(ks);
        const stored = await ks.storedIdentity(); // plaintext identity, no passphrase
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
  }, [configured, profile, keystore]);

  const unlock = useCallback(
    async (passphrase: string): Promise<void> => {
      if (!keystore) return;
      if (!profile) {
        setError('still loading your profile — try again in a moment');
        return;
      }
      const userId = profile.userId;
      setStatus('unlocking');
      setError(null);
      try {
        const storedIdent = await keystore.storedIdentity();
        const parsed = storedIdent ? parseDeviceIdentity(storedIdent) : null;
        // Create if: no stored device, stored device is legacy format, or stored device belongs to a different user.
        const creating = !parsed || parsed.deviceUuid === undefined || parsed.userId !== userId;
        let identity: string;
        let uuid: string;
        if (creating) {
          uuid = crypto.randomUUID();
          identity = formatDeviceIdentity(userId, uuid);
        } else {
          identity = storedIdent!; // composite identity already validated above
          uuid = parsed.deviceUuid!;
        }
        const dev = creating
          ? await keystore.getOrCreateDevice(identity, passphrase)
          : await keystore.loadDevice(identity, passphrase);
        if (!dev) throw new Error('no device found to unlock');
        const { pool: provisioned, result } = await provisionDevice(keystore, dev, passphrase);
        setDevice(dev);
        setPool(provisioned);
        setDeviceId(result.deviceId);
        setDeviceUuid(uuid);
        setPassphrase(passphrase); // retained in memory to seal advanced group state on send/receive (Slice 5)
        setSessionKey(await keystore.deriveSessionKey(passphrase)); // message-history seal key (memory only)
        setStatus('ready');
      } catch (err) {
        // openBackup fails closed on a wrong passphrase (GCM auth) — surface that distinctly.
        const wrong = err instanceof Error && /passphrase|decrypt/i.test(err.message);
        setError(wrong ? 'wrong passphrase' : 'could not unlock the device');
        setStatus(statusForStored(await keystore.storedIdentity(), userId));
      }
    },
    [keystore, profile],
  );

  const restore = useCallback(
    async (artifactJson: string, passphrase: string): Promise<void> => {
      if (!keystore) return;
      if (!profile) {
        setError('still loading your profile — try again in a moment');
        return;
      }
      const userId = profile.userId;
      // Restore always re-creates the device (clears + reimports), so generate a fresh deviceUuid.
      const uuid = crypto.randomUUID();
      const identity = formatDeviceIdentity(userId, uuid);
      setStatus('unlocking');
      setError(null);
      try {
        // Shared with the Settings recovery panel: restore → revoke now-stale packages → publish fresh (#20).
        const {
          device: dev,
          pool: provisioned,
          result,
        } = await restoreAndProvision(keystore, identity, artifactJson, passphrase);
        setDevice(dev);
        setPool(provisioned);
        setDeviceId(result.deviceId);
        setDeviceUuid(uuid);
        setPassphrase(passphrase); // see unlock — sealing key for advanced group state (Slice 5)
        setSessionKey(await keystore.deriveSessionKey(passphrase)); // message-history seal key (memory only)
        setStatus('ready');
      } catch (err) {
        // restore fails closed on a wrong passphrase / file / identity mismatch — keep the existing device.
        const bad =
          err instanceof Error &&
          /passphrase|decrypt|identity|artifact|recovery/i.test(err.message);
        setError(bad ? 'wrong passphrase or recovery file' : 'could not restore the device');
        setStatus(statusForStored(await keystore.storedIdentity(), userId));
      }
    },
    [keystore, profile],
  );

  const resetForNewAccount = useCallback(async (): Promise<void> => {
    if (!keystore) return;
    await keystore.clearDevice(); // wipes the other account's device + pool from this browser's single slot
    setPassphrase(null);
    setSessionKey(null);
    setError(null);
    setStatus('needs-create');
  }, [keystore]);

  const value: DeviceState = {
    device,
    pool,
    deviceId,
    deviceUuid,
    keystore,
    passphrase,
    sessionKey,
    status,
    error,
    unlock,
    restore,
    resetForNewAccount,
  };
  return <DeviceCtx.Provider value={value}>{children}</DeviceCtx.Provider>;
}

export function useDevice(): DeviceState {
  const ctx = useContext(DeviceCtx);
  if (!ctx) throw new Error('useDevice must be used within <DeviceProvider>');
  return ctx;
}
