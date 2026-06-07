import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { serializeKeyPackage, type DeviceKeys } from '@argus/crypto';

import { DeviceKeystore } from '../../lib/keystore';
import { provisionDevice } from '../../lib/provisioning';
import { restoreFromArtifact } from '../../lib/recovery';
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
  return stored === userId ? 'needs-unlock' : 'needs-switch';
}

interface DeviceState {
  device: DeviceKeys | null;
  /** The one-time KeyPackage pool (privates retained for join). */
  pool: DeviceKeys[] | null;
  /** This device's server id (from provisioning) — needed to list/fetch/consume Welcomes (Slice 4). */
  deviceId: string | null;
  keystore: DeviceKeystore | null;
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
  /**
   * Drop a CONSUMED one-time KeyPackage from the sealed + in-memory pool once its Welcome is joined —
   * forward secrecy (a one-time private is never reused or re-published). No-op until the device is unlocked.
   */
  prunePoolMember: (publicKeyPackageB64: string) => Promise<void>;
}

const DeviceCtx = createContext<DeviceState | null>(null);

export function DeviceProvider({ children }: { children: ReactNode }): ReactNode {
  const { configured, profile } = useAuth();
  const [keystore, setKeystore] = useState<DeviceKeystore | null>(null);
  const [device, setDevice] = useState<DeviceKeys | null>(null);
  const [pool, setPool] = useState<DeviceKeys[] | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  // The session passphrase, kept in memory (like the unlocked keys) only to re-seal the pool when a
  // consumed member is pruned (Slice 4). Never logged, persisted, or transmitted. A ref — not state — so
  // it stays out of the React tree and never triggers a re-render.
  const passphraseRef = useRef<string | null>(null);
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
      const identity = profile.userId; // stable per-user MLS device identity
      setStatus('unlocking');
      setError(null);
      try {
        // "Creating" iff this browser holds NO device for ME (none, or another account's) — identity-keyed,
        // not mere presence, so a foreign slot never forces us into a doomed loadDevice.
        const creating = (await keystore.storedIdentity()) !== identity;
        const dev = creating
          ? await keystore.getOrCreateDevice(identity, passphrase)
          : await keystore.loadDevice(identity, passphrase);
        if (!dev) throw new Error('no device found to unlock');
        const { pool: provisioned, result } = await provisionDevice(keystore, dev, passphrase);
        passphraseRef.current = passphrase;
        setDevice(dev);
        setPool(provisioned);
        setDeviceId(result.deviceId);
        setStatus('ready');
      } catch (err) {
        // openBackup fails closed on a wrong passphrase (GCM auth) — surface that distinctly.
        const wrong = err instanceof Error && /passphrase|decrypt/i.test(err.message);
        setError(wrong ? 'wrong passphrase' : 'could not unlock the device');
        setStatus(statusForStored(await keystore.storedIdentity(), identity));
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
      const identity = profile.userId;
      setStatus('unlocking');
      setError(null);
      try {
        await restoreFromArtifact(identity, artifactJson, passphrase);
        const dev = await keystore.loadDevice(identity, passphrase);
        if (!dev) throw new Error('restore did not produce a device');
        const { pool: provisioned, result } = await provisionDevice(keystore, dev, passphrase);
        passphraseRef.current = passphrase;
        setDevice(dev);
        setPool(provisioned);
        setDeviceId(result.deviceId);
        setStatus('ready');
      } catch (err) {
        // restore fails closed on a wrong passphrase / file / identity mismatch — keep the existing device.
        const bad =
          err instanceof Error &&
          /passphrase|decrypt|identity|artifact|recovery/i.test(err.message);
        setError(bad ? 'wrong passphrase or recovery file' : 'could not restore the device');
        setStatus(statusForStored(await keystore.storedIdentity(), identity));
      }
    },
    [keystore, profile],
  );

  const resetForNewAccount = useCallback(async (): Promise<void> => {
    if (!keystore) return;
    await keystore.clearDevice(); // wipes the other account's device + pool from this browser's single slot
    setError(null);
    setStatus('needs-create');
  }, [keystore]);

  const prunePoolMember = useCallback(
    async (publicKeyPackageB64: string): Promise<void> => {
      const passphrase = passphraseRef.current;
      if (!keystore || !device || !passphrase) return; // not unlocked yet — nothing to prune
      await keystore.removePoolMember(device, passphrase, publicKeyPackageB64);
      setPool(
        (prev) =>
          prev?.filter((m) => serializeKeyPackage(m.publicPackage) !== publicKeyPackageB64) ?? prev,
      );
    },
    [keystore, device],
  );

  const value: DeviceState = {
    device,
    pool,
    deviceId,
    keystore,
    status,
    error,
    unlock,
    restore,
    resetForNewAccount,
    prunePoolMember,
  };
  return <DeviceCtx.Provider value={value}>{children}</DeviceCtx.Provider>;
}

export function useDevice(): DeviceState {
  const ctx = useContext(DeviceCtx);
  if (!ctx) throw new Error('useDevice must be used within <DeviceProvider>');
  return ctx;
}
