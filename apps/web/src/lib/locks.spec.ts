import { describe, expect, it } from 'vitest';

import { conversationLock, withLock } from './locks';

// jsdom/node have no Web Locks API, so these exercise the in-process fallback mutex — the same ordering the
// Web Locks path gives within a tab. (The cross-tab guarantee is the browser's Web Locks + the keystore CAS.)

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('withLock', () => {
  it('serializes overlapping calls on the same name', async () => {
    const order: string[] = [];
    const a = withLock('n', async () => {
      order.push('a-start');
      await tick();
      order.push('a-end');
    });
    const b = withLock('n', async () => {
      order.push('b-start');
      order.push('b-end');
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']); // b waited for a to finish
  });

  it('propagates the result and a rejection without poisoning the next waiter', async () => {
    await expect(
      withLock('n', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // The chain must still let the next holder run after a throwing one.
    await expect(withLock('n', async () => 'ok')).resolves.toBe('ok');
  });

  it('runs different names concurrently', async () => {
    const order: string[] = [];
    await Promise.all([
      withLock('a', async () => {
        order.push('a-start');
        await tick();
        order.push('a-end');
      }),
      withLock('b', async () => {
        order.push('b-start');
        await tick();
        order.push('b-end');
      }),
    ]);
    // Both start before either ends — they did not serialize against each other.
    expect(order.slice(0, 2).sort()).toEqual(['a-start', 'b-start']);
  });

  it('namespaces a conversation lock', () => {
    expect(conversationLock('abc')).toBe('argus-mls:abc');
  });
});
