import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

import type { FetchedMessage } from '../messaging/messaging.service.js';

/** A newly-stored message, ready to fan out to subscribed sockets. CIPHERTEXT ONLY (FetchedMessage). */
export interface MessageCreatedEvent {
  tenantId: string;
  conversationId: string;
  message: FetchedMessage;
}

/**
 * In-process event bus decoupling the HTTP send path (emitter) from the WebSocket gateway (listener),
 * so neither module depends on the other. Single-pod only — cross-pod fan-out is the Redis backplane
 * (checkpoint 29), which will publish/subscribe these same events over Redis.
 */
@Injectable()
export class RealtimeBus {
  private readonly emitter = new EventEmitter();

  emitMessageCreated(event: MessageCreatedEvent): void {
    this.emitter.emit('message.created', event);
  }

  onMessageCreated(listener: (event: MessageCreatedEvent) => void): void {
    this.emitter.on('message.created', listener);
  }
}
