import {
  MlsEngine,
  deviceSignaturePublicKeyB64,
  serializeKeyPackage,
  type Argon2Params,
} from '@argus/crypto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the directory call so the test doesn't hit the network; everything else is real.
vi.mock('./api', () => ({ publishKeyPackages: vi.fn() }));
import { publishKeyPackages } from './api';
import { DeviceKeystore } from './keystore';
import { provisionDevice } from './provisioning';

const FAST: Argon2Params = { m: 8192, t: 2, p: 1 };
const publish = vi.mocked(publishKeyPackages);

describe('provisionDevice', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    publish.mockReset();
    publish.mockResolvedValue({ deviceId: 'd', published: 10 });
  });

  it('ensures the pool and publishes its PUBLIC KeyPackages under the signature key', async () => {
    const engine = await MlsEngine.create();
    const ks = await DeviceKeystore.open(engine, FAST);
    const device = await ks.getOrCreateDevice('u1', 'pw');

    const { pool } = await provisionDevice(ks, device, 'pw');

    expect(publish).toHaveBeenCalledTimes(1);
    const [sig, keyPackages] = publish.mock.calls[0]!;
    // registers under the device's stable signature key
    expect(sig).toBe(deviceSignaturePublicKeyB64(device));
    // publishes exactly the pool's PUBLIC KeyPackages (serialized) — no private material
    expect(keyPackages).toEqual(pool.map((m) => serializeKeyPackage(m.publicPackage)));
    expect(keyPackages.length).toBeGreaterThan(0);
  });

  it('is idempotent: a second provision republishes the same (already-sealed) pool', async () => {
    const engine = await MlsEngine.create();
    const ks = await DeviceKeystore.open(engine, FAST);
    const device = await ks.getOrCreateDevice('u1', 'pw');

    await provisionDevice(ks, device, 'pw');
    const first = publish.mock.calls[0]![1];
    await provisionDevice(ks, device, 'pw');
    const second = publish.mock.calls[1]![1];
    expect(second).toEqual(first); // same pool — the server dedups, so re-publish is a safe no-op
  });
});
