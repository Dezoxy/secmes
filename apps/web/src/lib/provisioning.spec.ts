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
    // Default: the directory already has a full pool unclaimed → no replenishment needed.
    publish.mockResolvedValue({ deviceId: 'd', published: 10, available: 10 });
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

  it('replenishes with fresh packages when the server reports availability below target', async () => {
    const engine = await MlsEngine.create();
    const ks = await DeviceKeystore.open(engine, FAST);
    const device = await ks.getOrCreateDevice('u1', 'pw');

    // First publish: only 2 of the 10 remain unclaimed (8 were claimed while offline). Second publish
    // (the replenishment) tops the directory back up to 10.
    publish
      .mockReset()
      .mockResolvedValueOnce({ deviceId: 'd', published: 10, available: 2 })
      .mockResolvedValueOnce({ deviceId: 'd', published: 8, available: 10 });

    await provisionDevice(ks, device, 'pw');

    expect(publish).toHaveBeenCalledTimes(2);
    // the replenishment publishes 8 FRESH replacements (target 10 − available 2)…
    expect(publish.mock.calls[1]![1]).toHaveLength(8);
    // …which are distinct from the originally published 10 (genuinely new one-time KeyPackages)
    const firstBatch = new Set(publish.mock.calls[0]![1]);
    expect(publish.mock.calls[1]![1].every((kp) => !firstBatch.has(kp))).toBe(true);
  });

  it('chunks publishing when the retained pool exceeds the server per-request limit', async () => {
    const engine = await MlsEngine.create();
    const ks = await DeviceKeystore.open(engine, FAST);
    const device = await ks.getOrCreateDevice('u1', 'pw');
    await ks.ensurePool(device, 'pw', 105); // a grown pool (> the 100-per-request server limit)
    publish.mockReset().mockResolvedValue({ deviceId: 'd', published: 0, available: 105 });

    await provisionDevice(ks, device, 'pw');

    // 105 members → two requests within the limit (100 + 5); no batch exceeds the contract.
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls.every((c) => c[1].length <= 100)).toBe(true);
    expect(publish.mock.calls[0]![1]).toHaveLength(100);
    expect(publish.mock.calls[1]![1]).toHaveLength(5);
  });
});
