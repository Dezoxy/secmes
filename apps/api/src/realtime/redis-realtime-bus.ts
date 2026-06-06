import { type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

import {
  MessageCreatedEventSchema,
  RealtimeBus,
  type MessageCreatedEvent,
} from './realtime-bus.js';

export const CHANNEL = 'argus:realtime:message-created';

/**
 * Cross-pod bus (checkpoint 29): each send PUBLISHES the event to a Redis channel, and every gateway
 * pod SUBSCRIBES and fans it out to its own local sockets. So a message sent on pod A reaches a
 * recipient connected to pod B. The same opaque ciphertext envelope crosses Redis — never plaintext or
 * keys; Redis is a private, authenticated dependency (network-isolated; see threat model). The emitting
 * pod also delivers via the Redis round-trip (uniform path), so single-pod works too.
 */
export class RedisRealtimeBus extends RealtimeBus implements OnModuleDestroy {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly listeners: Array<(event: MessageCreatedEvent) => void> = [];
  /** Resolves once the subscription is active — await before relying on receipt (readiness/tests). */
  readonly ready: Promise<void>;

  constructor(url: string) {
    super();
    this.pub = new Redis(url, { maxRetriesPerRequest: null });
    this.sub = this.pub.duplicate();
    // A transient Redis error must not crash the process (ioredis reconnects automatically). No secret
    // is in these errors; operational logging/metrics are a later concern.
    this.pub.on('error', () => {});
    this.sub.on('error', () => {});
    this.sub.on('message', (_channel, payload) => this.onPayload(payload));
    this.ready = this.sub.subscribe(CHANNEL).then(() => undefined);
  }

  private onPayload(payload: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch {
      return; // ignore non-JSON
    }
    const parsed = MessageCreatedEventSchema.safeParse(raw);
    if (!parsed.success) return; // ignore a malformed/poisoned event rather than crash the gateway
    for (const listener of this.listeners) listener(parsed.data);
  }

  emitMessageCreated(event: MessageCreatedEvent): void {
    void this.pub.publish(CHANNEL, JSON.stringify(event));
  }

  onMessageCreated(listener: (event: MessageCreatedEvent) => void): void {
    this.listeners.push(listener);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}
