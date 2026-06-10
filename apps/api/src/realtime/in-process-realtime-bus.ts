import { EventEmitter } from 'node:events';

import { RealtimeBus, type MessageCreatedEvent, type WelcomeCreatedEvent } from './realtime-bus.js';

/**
 * Single-pod (and dev/test) bus — direct in-process delivery via a Node EventEmitter, no external
 * dependency. Used when REDIS_URL is unset. Cross-pod delivery uses RedisRealtimeBus instead.
 */
export class InProcessRealtimeBus extends RealtimeBus {
  private readonly emitter = new EventEmitter();

  emitMessageCreated(event: MessageCreatedEvent): void {
    this.emitter.emit('message.created', event);
  }

  onMessageCreated(listener: (event: MessageCreatedEvent) => void): void {
    this.emitter.on('message.created', listener);
  }

  emitWelcomeCreated(event: WelcomeCreatedEvent): void {
    this.emitter.emit('welcome.created', event);
  }

  onWelcomeCreated(listener: (event: WelcomeCreatedEvent) => void): void {
    this.emitter.on('welcome.created', listener);
  }
}
