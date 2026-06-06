import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import type { DeviceKeys } from '@argus/crypto';

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
  | 'needs-unlock' // a sealed device exists — enter the passphrase
  | 'unlocking' // unsealing + provisioning
  | 'ready' // unlocked + pool published (or demo passthrough)
  | 'error';

interface DeviceState {
  device: DeviceKeys | null;
  /** The one-time KeyPackage pool (privates retained for join). */
  pool: DeviceKeys[] | null;
  keystore: DeviceKeystore | null;
  status: DeviceStatus;
  error: string | null;
  /** Unlock (or create on first run) the device, then provision + publish its KeyPackage pool. */
  unlock: (passphrase: string) => Promise<void>;
}

const DeviceCtx = createContext<DeviceState | null>(null);

export function DeviceProvider({ children }: { children: ReactNode }): ReactNode {
  const { configured, profile } = useAuth();
  const [keystore, setKeystore] = useState<DeviceKeystore | null>(null);
  const [device, setDevice] = useState<DeviceKeys | null>(null);
  const [pool, setPool] = useState<DeviceKeys[] | null>(null);
  // Demo mode has no real device — render the chat (seed-driven) without a gate.
  const [status, setStatus] = useState<DeviceStatus>(configured ? 'loading' : 'ready');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!configured) return; // demo: no keystore, no provisioning
    let active = true;
    void (async () => {
      try {
        const ks = await DeviceKeystore.open();
        if (!active) return;
        setKeystore(ks);
        setStatus((await ks.hasDevice()) ? 'needs-unlock' : 'needs-create');
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
  }, [configured]);

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
        const creating = !(await keystore.hasDevice());
        const dev = creating
          ? await keystore.getOrCreateDevice(identity, passphrase)
          : await keystore.loadDevice(identity, passphrase);
        if (!dev) throw new Error('no device found to unlock');
        const { pool: provisioned } = await provisionDevice(keystore, dev, passphrase);
        setDevice(dev);
        setPool(provisioned);
        setStatus('ready');
      } catch (err) {
        // openBackup fails closed on a wrong passphrase (GCM auth) — surface that distinctly.
        const wrong = err instanceof Error && /passphrase|decrypt/i.test(err.message);
        setError(wrong ? 'wrong passphrase' : 'could not unlock the device');
        setStatus((await keystore.hasDevice()) ? 'needs-unlock' : 'needs-create');
      }
    },
    [keystore, profile],
  );

  const value: DeviceState = { device, pool, keystore, status, error, unlock };
  return <DeviceCtx.Provider value={value}>{children}</DeviceCtx.Provider>;
}

export function useDevice(): DeviceState {
  const ctx = useContext(DeviceCtx);
  if (!ctx) throw new Error('useDevice must be used within <DeviceProvider>');
  return ctx;
}
