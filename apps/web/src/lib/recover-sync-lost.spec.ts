import { describe, expect, it, vi } from 'vitest';
import type { Conversation as MlsGroup } from '@argus/crypto';
import type { DeviceKeystore } from './keystore';
import { recoverSyncLost } from './recover-sync-lost';

// A minimal MLS group stand-in — recoverSyncLost only ever uses it as a Map value (identity), never
// calls into it, so an opaque object cast is sufficient and keeps the test free of crypto setup.
const fakeGroup = {} as MlsGroup;

function makeKeystore(deleteImpl?: () => Promise<void>): {
  keystore: DeviceKeystore;
  deleteConversationState: ReturnType<typeof vi.fn>;
} {
  const deleteConversationState = vi.fn(deleteImpl ?? (() => Promise.resolve()));
  // Only deleteConversationState is exercised; cast the partial through unknown.
  const keystore = { deleteConversationState } as unknown as DeviceKeystore;
  return { keystore, deleteConversationState };
}

describe('recoverSyncLost', () => {
  it('clears the broken group state, drops it from liveGroups, and re-drives the drain', async () => {
    const { keystore, deleteConversationState } = makeKeystore();
    const liveGroups = new Map<string, MlsGroup>([
      ['conv-a', fakeGroup],
      ['conv-b', fakeGroup],
    ]);
    const redrain = vi.fn();

    await recoverSyncLost(keystore, 'conv-a', liveGroups, redrain);

    expect(deleteConversationState).toHaveBeenCalledWith('conv-a');
    expect(liveGroups.has('conv-a')).toBe(false);
    expect(liveGroups.has('conv-b')).toBe(true); // only the sync-lost conversation is dropped
    expect(redrain).toHaveBeenCalledTimes(1);
  });

  it('drops the in-memory group before awaiting the keystore delete (no live path races a doomed ratchet)', async () => {
    const order: string[] = [];
    const { keystore } = makeKeystore(() => {
      order.push('delete');
      return Promise.resolve();
    });
    const liveGroups = {
      delete: vi.fn((id: string) => {
        order.push(`liveGroups.delete:${id}`);
        return true;
      }),
    } as unknown as Map<string, MlsGroup>;
    const redrain = vi.fn(() => order.push('redrain'));

    await recoverSyncLost(keystore, 'conv-a', liveGroups, redrain);

    expect(order).toEqual(['liveGroups.delete:conv-a', 'delete', 'redrain']);
  });

  it('isolates a keystore failure — never throws into the caller, and does not re-drive on failure', async () => {
    const { keystore } = makeKeystore(() => Promise.reject(new Error('idb unavailable')));
    const liveGroups = new Map<string, MlsGroup>([['conv-a', fakeGroup]]);
    const redrain = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(recoverSyncLost(keystore, 'conv-a', liveGroups, redrain)).resolves.toBeUndefined();

    expect(liveGroups.has('conv-a')).toBe(false); // the in-memory drop ran before the failing await
    expect(redrain).not.toHaveBeenCalled(); // the throw skips the re-drive; a later reconnect retries
    expect(warn).toHaveBeenCalledTimes(1);
    // The id is passed as a SEPARATE arg, never interpolated into the format string (safe logging).
    expect(warn.mock.calls[0]?.[1]).toBe('conv-a');
    warn.mockRestore();
  });
});
