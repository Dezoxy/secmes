import { EventEmitter } from 'node:events';

import {
  RealtimeBus,
  type CommitCreatedEvent,
  type DeviceEnrollmentApprovedEvent,
  type DeviceEnrollmentPendingEvent,
  type MemberRemovedEvent,
  type MessageCreatedEvent,
  type ReceiptAdvancedEvent,
  type WelcomeCreatedEvent,
} from './realtime-bus.js';

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

  emitReceiptAdvanced(event: ReceiptAdvancedEvent): void {
    this.emitter.emit('receipt.advanced', event);
  }

  onReceiptAdvanced(listener: (event: ReceiptAdvancedEvent) => void): void {
    this.emitter.on('receipt.advanced', listener);
  }

  emitCommitCreated(event: CommitCreatedEvent): void {
    this.emitter.emit('commit.created', event);
  }

  onCommitCreated(listener: (event: CommitCreatedEvent) => void): void {
    this.emitter.on('commit.created', listener);
  }

  emitMemberRemoved(event: MemberRemovedEvent): void {
    this.emitter.emit('member.removed', event);
  }

  onMemberRemoved(listener: (event: MemberRemovedEvent) => void): void {
    this.emitter.on('member.removed', listener);
  }

  emitDeviceEnrollmentPending(event: DeviceEnrollmentPendingEvent): void {
    this.emitter.emit('device.enrollment.pending', event);
  }

  onDeviceEnrollmentPending(listener: (event: DeviceEnrollmentPendingEvent) => void): void {
    this.emitter.on('device.enrollment.pending', listener);
  }

  emitDeviceEnrollmentApproved(event: DeviceEnrollmentApprovedEvent): void {
    this.emitter.emit('device.enrollment.approved', event);
  }

  onDeviceEnrollmentApproved(listener: (event: DeviceEnrollmentApprovedEvent) => void): void {
    this.emitter.on('device.enrollment.approved', listener);
  }
}
