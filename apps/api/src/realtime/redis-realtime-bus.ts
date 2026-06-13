import { type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

import {
  CommitCreatedEventSchema,
  DeviceEnrollmentApprovedEventSchema,
  DeviceEnrollmentPendingEventSchema,
  MemberRemovedEventSchema,
  MessageCreatedEventSchema,
  ReceiptAdvancedEventSchema,
  RealtimeBus,
  WelcomeCreatedEventSchema,
  type CommitCreatedEvent,
  type DeviceEnrollmentApprovedEvent,
  type DeviceEnrollmentPendingEvent,
  type MemberRemovedEvent,
  type MessageCreatedEvent,
  type ReceiptAdvancedEvent,
  type WelcomeCreatedEvent,
} from './realtime-bus.js';

export const CHANNEL = 'argus:realtime:message-created';
export const WELCOME_CHANNEL = 'argus:realtime:welcome-created';
export const RECEIPT_CHANNEL = 'argus:realtime:receipt-advanced';
export const COMMIT_CHANNEL = 'argus:realtime:commit-created';
export const MEMBER_REMOVED_CHANNEL = 'argus:realtime:member-removed';
export const ENROLLMENT_PENDING_CHANNEL = 'argus:realtime:device-enrollment-pending';
export const ENROLLMENT_APPROVED_CHANNEL = 'argus:realtime:device-enrollment-approved';

/**
 * Cross-pod bus (checkpoint 29): each send PUBLISHES the event to a Redis channel, and every gateway
 * pod SUBSCRIBES and fans it out to its own local sockets. So a message sent on pod A reaches a
 * recipient connected to pod B. The same opaque ciphertext envelope crosses Redis — never plaintext or
 * keys; Redis is a private, authenticated dependency (network-isolated; see threat model). The emitting
 * pod also delivers via the Redis round-trip (uniform path), so single-pod works too. Welcome events
 * ride a second channel with the same posture (ids + the recipient subject only — never the sealed blobs).
 */
export class RedisRealtimeBus extends RealtimeBus implements OnModuleDestroy {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly listeners: Array<(event: MessageCreatedEvent) => void> = [];
  private readonly welcomeListeners: Array<(event: WelcomeCreatedEvent) => void> = [];
  private readonly receiptListeners: Array<(event: ReceiptAdvancedEvent) => void> = [];
  private readonly commitListeners: Array<(event: CommitCreatedEvent) => void> = [];
  private readonly memberRemovedListeners: Array<(event: MemberRemovedEvent) => void> = [];
  private readonly enrollmentPendingListeners: Array<
    (event: DeviceEnrollmentPendingEvent) => void
  > = [];
  private readonly enrollmentApprovedListeners: Array<
    (event: DeviceEnrollmentApprovedEvent) => void
  > = [];
  /** Resolves once the subscriptions are active — await before relying on receipt (readiness/tests). */
  readonly ready: Promise<void>;

  constructor(url: string) {
    super();
    // Publisher: NO offline queue. Real-time delivery is best-effort — the message is already durable in
    // the DB and the recipient back-fills via REST on reconnect. If Redis is down, a publish must fail
    // fast and be dropped, NOT accumulate unboundedly in ioredis' in-memory offline queue.
    this.pub = new Redis(url, { enableOfflineQueue: false });
    // Subscriber: a separate connection (subscribed connections can't issue normal commands). Keep its
    // default queue + no per-request retry cap so it re-subscribes cleanly across reconnects.
    this.sub = new Redis(url, { maxRetriesPerRequest: null });
    // A transient Redis error must not crash the process (ioredis reconnects automatically). No secret
    // is in these errors; operational logging/metrics are a later concern.
    this.pub.on('error', () => {});
    this.sub.on('error', () => {});
    this.sub.on('message', (channel, payload) => this.onPayload(channel, payload));
    this.ready = this.sub
      .subscribe(
        CHANNEL,
        WELCOME_CHANNEL,
        RECEIPT_CHANNEL,
        COMMIT_CHANNEL,
        MEMBER_REMOVED_CHANNEL,
        ENROLLMENT_PENDING_CHANNEL,
        ENROLLMENT_APPROVED_CHANNEL,
      )
      .then(() => undefined);
  }

  private onPayload(channel: string, payload: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch {
      return; // ignore non-JSON
    }
    // Validate per channel; ignore a malformed/poisoned event rather than crash the gateway.
    if (channel === CHANNEL) {
      const parsed = MessageCreatedEventSchema.safeParse(raw);
      if (!parsed.success) return;
      for (const listener of this.listeners) listener(parsed.data);
      return;
    }
    if (channel === WELCOME_CHANNEL) {
      const parsed = WelcomeCreatedEventSchema.safeParse(raw);
      if (!parsed.success) return;
      for (const listener of this.welcomeListeners) listener(parsed.data);
      return;
    }
    if (channel === RECEIPT_CHANNEL) {
      const parsed = ReceiptAdvancedEventSchema.safeParse(raw);
      if (!parsed.success) return;
      for (const listener of this.receiptListeners) listener(parsed.data);
      return;
    }
    if (channel === COMMIT_CHANNEL) {
      const parsed = CommitCreatedEventSchema.safeParse(raw);
      if (!parsed.success) return;
      for (const listener of this.commitListeners) listener(parsed.data);
      return;
    }
    if (channel === MEMBER_REMOVED_CHANNEL) {
      const parsed = MemberRemovedEventSchema.safeParse(raw);
      if (!parsed.success) return;
      for (const listener of this.memberRemovedListeners) listener(parsed.data);
      return;
    }
    if (channel === ENROLLMENT_PENDING_CHANNEL) {
      const parsed = DeviceEnrollmentPendingEventSchema.safeParse(raw);
      if (!parsed.success) return;
      for (const listener of this.enrollmentPendingListeners) listener(parsed.data);
      return;
    }
    if (channel === ENROLLMENT_APPROVED_CHANNEL) {
      const parsed = DeviceEnrollmentApprovedEventSchema.safeParse(raw);
      if (!parsed.success) return;
      for (const listener of this.enrollmentApprovedListeners) listener(parsed.data);
    }
  }

  emitMessageCreated(event: MessageCreatedEvent): void {
    // Fire-and-forget; with enableOfflineQueue:false a publish REJECTS when Redis is down, so we must
    // swallow it (an unhandled rejection would crash the process). Dropping it is correct — best-effort.
    this.pub.publish(CHANNEL, JSON.stringify(event)).catch(() => {});
  }

  onMessageCreated(listener: (event: MessageCreatedEvent) => void): void {
    this.listeners.push(listener);
  }

  emitWelcomeCreated(event: WelcomeCreatedEvent): void {
    // Same best-effort posture as messages: the Welcome row is durable; join-on-connect is the fallback.
    this.pub.publish(WELCOME_CHANNEL, JSON.stringify(event)).catch(() => {});
  }

  onWelcomeCreated(listener: (event: WelcomeCreatedEvent) => void): void {
    this.welcomeListeners.push(listener);
  }

  emitReceiptAdvanced(event: ReceiptAdvancedEvent): void {
    // Same best-effort posture as messages/welcomes: the watermark is durable in the DB; a peer reconciles
    // via GET /receipts on reconnect. A dropped publish (Redis down) just delays a tick flip.
    this.pub.publish(RECEIPT_CHANNEL, JSON.stringify(event)).catch(() => {});
  }

  onReceiptAdvanced(listener: (event: ReceiptAdvancedEvent) => void): void {
    this.receiptListeners.push(listener);
  }

  emitCommitCreated(event: CommitCreatedEvent): void {
    this.pub.publish(COMMIT_CHANNEL, JSON.stringify(event)).catch(() => {});
  }

  onCommitCreated(listener: (event: CommitCreatedEvent) => void): void {
    this.commitListeners.push(listener);
  }

  emitMemberRemoved(event: MemberRemovedEvent): void {
    this.pub.publish(MEMBER_REMOVED_CHANNEL, JSON.stringify(event)).catch(() => {});
  }

  onMemberRemoved(listener: (event: MemberRemovedEvent) => void): void {
    this.memberRemovedListeners.push(listener);
  }

  emitDeviceEnrollmentPending(event: DeviceEnrollmentPendingEvent): void {
    this.pub.publish(ENROLLMENT_PENDING_CHANNEL, JSON.stringify(event)).catch(() => {});
  }

  onDeviceEnrollmentPending(listener: (event: DeviceEnrollmentPendingEvent) => void): void {
    this.enrollmentPendingListeners.push(listener);
  }

  emitDeviceEnrollmentApproved(event: DeviceEnrollmentApprovedEvent): void {
    this.pub.publish(ENROLLMENT_APPROVED_CHANNEL, JSON.stringify(event)).catch(() => {});
  }

  onDeviceEnrollmentApproved(listener: (event: DeviceEnrollmentApprovedEvent) => void): void {
    this.enrollmentApprovedListeners.push(listener);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}
