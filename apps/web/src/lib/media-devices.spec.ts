import { afterEach, describe, expect, it, vi } from 'vitest';

import { enumerateAudioInputs, getAudioStream, queryMicPermission } from './media-devices';

const originalNavigator = globalThis.navigator;

function setNavigator(overrides: Partial<typeof navigator>): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...originalNavigator, ...overrides },
    writable: true,
    configurable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', {
    value: originalNavigator,
    writable: true,
    configurable: true,
  });
});

describe('queryMicPermission', () => {
  it('returns granted when the permission state is granted', async () => {
    setNavigator({
      permissions: {
        query: vi.fn().mockResolvedValue({ state: 'granted' }),
      } as unknown as Permissions,
    });
    expect(await queryMicPermission()).toBe('granted');
  });

  it('returns denied when the permission state is denied', async () => {
    setNavigator({
      permissions: {
        query: vi.fn().mockResolvedValue({ state: 'denied' }),
      } as unknown as Permissions,
    });
    expect(await queryMicPermission()).toBe('denied');
  });

  it('returns prompt when the permission state is prompt', async () => {
    setNavigator({
      permissions: {
        query: vi.fn().mockResolvedValue({ state: 'prompt' }),
      } as unknown as Permissions,
    });
    expect(await queryMicPermission()).toBe('prompt');
  });

  it('returns unavailable when the Permissions API is absent', async () => {
    setNavigator({ permissions: undefined as unknown as Permissions });
    expect(await queryMicPermission()).toBe('unavailable');
  });

  it('returns unavailable when query throws', async () => {
    setNavigator({
      permissions: {
        query: vi.fn().mockRejectedValue(new Error('not supported')),
      } as unknown as Permissions,
    });
    expect(await queryMicPermission()).toBe('unavailable');
  });
});

describe('getAudioStream', () => {
  it('calls getUserMedia with audio:true, video:false', async () => {
    const fakeStream = {} as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(fakeStream);
    setNavigator({
      mediaDevices: { getUserMedia } as unknown as MediaDevices,
    });
    const result = await getAudioStream();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(result).toBe(fakeStream);
  });

  it('throws when getUserMedia is unavailable', async () => {
    setNavigator({ mediaDevices: undefined as unknown as MediaDevices });
    await expect(getAudioStream()).rejects.toThrow();
  });

  it('propagates the rejection when the user denies permission', async () => {
    const err = new DOMException('Permission denied', 'NotAllowedError');
    setNavigator({
      mediaDevices: {
        getUserMedia: vi.fn().mockRejectedValue(err),
      } as unknown as MediaDevices,
    });
    await expect(getAudioStream()).rejects.toThrow('Permission denied');
  });
});

describe('enumerateAudioInputs', () => {
  it('returns only audioinput devices', async () => {
    const devices: Partial<MediaDeviceInfo>[] = [
      { kind: 'audioinput', deviceId: 'mic1', label: '', groupId: '' },
      { kind: 'videoinput', deviceId: 'cam1', label: '', groupId: '' },
      { kind: 'audiooutput', deviceId: 'spk1', label: '', groupId: '' },
      { kind: 'audioinput', deviceId: 'mic2', label: '', groupId: '' },
    ];
    setNavigator({
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue(devices),
      } as unknown as MediaDevices,
    });
    const result = await enumerateAudioInputs();
    expect(result).toHaveLength(2);
    expect(result.every((d) => d.kind === 'audioinput')).toBe(true);
  });

  it('returns empty array when mediaDevices is unavailable', async () => {
    setNavigator({ mediaDevices: undefined as unknown as MediaDevices });
    expect(await enumerateAudioInputs()).toEqual([]);
  });
});
