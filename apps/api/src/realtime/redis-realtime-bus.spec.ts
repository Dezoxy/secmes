import { Redis } from 'ioredis';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { CHANNEL, RedisRealtimeBus } from './redis-realtime-bus.js';
import type { MessageCreatedEvent } from './realtime-bus.js';

// Integration — proves the Redis backplane fans a published event out to a subscriber on ANOTHER bus
// instance (i.e. another pod). Needs a live Redis; auto-skips without REDIS_URL.
const REDIS_URL = process.env.REDIS_URL;

const u = (n: number): string => `550e8400-e29b-41d4-a716-44665544000${n}`;
const sample: MessageCreatedEvent = {
  tenantId: u(0),
  conversationId: u(1),
  message: {
    id: u(2),
    senderUserId: u(3),
    clientMessageId: u(4),
    ciphertext: 'b3BhcXVl',
    alg: 'MLS_1.0',
    epoch: 3,
    attachmentObjectKey: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
};

describe.skipIf(!REDIS_URL)('RedisRealtimeBus — cross-pod fan-out', () => {
  const buses: RedisRealtimeBus[] = [];
  let raw: Redis | undefined;
  const mkBus = (): RedisRealtimeBus => {
    const b = new RedisRealtimeBus(REDIS_URL as string);
    buses.push(b);
    return b;
  };

  afterAll(async () => {
    await Promise.all(buses.map((b) => b.onModuleDestroy()));
    await raw?.quit();
  });

  it('a message published on one bus reaches a subscriber on another (cross-pod)', async () => {
    const podA = mkBus();
    const podB = mkBus();
    await Promise.all([podA.ready, podB.ready]); // both subscribed before publishing
    const received: MessageCreatedEvent[] = [];
    podB.onMessageCreated((e) => received.push(e));

    podA.emitMessageCreated(sample);
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 2000, interval: 20 });
    expect(received[0]).toEqual(sample); // delivered to the OTHER pod, verbatim
  });

  it('ignores a malformed payload but still delivers a valid one', async () => {
    const pod = mkBus();
    await pod.ready;
    const received: MessageCreatedEvent[] = [];
    pod.onMessageCreated((e) => received.push(e));

    raw = new Redis(REDIS_URL as string, { maxRetriesPerRequest: null });
    await raw.publish(CHANNEL, 'not-json'); // garbage
    await raw.publish(CHANNEL, JSON.stringify({ tenantId: 'x' })); // wrong shape
    await raw.publish(CHANNEL, JSON.stringify(sample)); // valid

    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 2000, interval: 20 });
    expect(received[0]).toEqual(sample); // only the valid event got through
  });
});
