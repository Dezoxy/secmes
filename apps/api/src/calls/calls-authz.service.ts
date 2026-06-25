import { Injectable } from '@nestjs/common';

import { RealtimeBus } from '../realtime/realtime-bus.js';

/** No answer from callee within this window → server emits timeout + drops the authz entry. */
const RING_TIMEOUT_MS = 45_000;
/** Max silence between signal frames once a call is active → server emits peer-gone. */
const CALL_SIGNAL_ACTIVITY_MS = 90_000;
/** Hard cap on call duration regardless of activity. */
const MAX_CALL_DURATION_MS = 90 * 60_000;

interface AuthzEntry {
  tenantId: string;
  conversationId: string;
  /** Caller's external identity subject (`users.external_identity_id`). */
  callerSub: string;
  /** Callee's external identity subject — used for socket routing and participant validation. */
  calleeSub: string;
  phase: 'ringing' | 'active';
  armedAt: number;
  lastSignalAt: number;
  ringTimer: ReturnType<typeof setTimeout>;
  activityTimer?: ReturnType<typeof setTimeout>;
  maxDurationTimer?: ReturnType<typeof setTimeout>;
}

/**
 * In-memory call-authorization map. Tracks every live call's participants and lifecycle so the
 * gateway can validate `call.signal` frames without a DB lookup (calls are ephemeral in V1 —
 * no `call_sessions` table until V1.1 / P3-DB). Lost on process restart — calls fail cleanly,
 * no stale entries survive a restart. Exported from CallsModule so RealtimeGateway can inject it.
 */
@Injectable()
export class CallsAuthzService {
  private readonly authzMap = new Map<string, AuthzEntry>();

  constructor(private readonly bus: RealtimeBus) {}

  /**
   * Register a live call after the invite's friendship + membership gates pass. Arms the ring
   * timer; if the callee never responds within RING_TIMEOUT_MS the entry is released and a
   * server-issued `call.end{timeout}` is emitted to the conversation room.
   */
  register(
    callId: string,
    opts: {
      tenantId: string;
      conversationId: string;
      callerSub: string;
      calleeSub: string;
    },
  ): void {
    const now = Date.now();
    const ringTimer = setTimeout(() => this.expireEntry(callId, 'timeout'), RING_TIMEOUT_MS);
    this.authzMap.set(callId, {
      tenantId: opts.tenantId,
      conversationId: opts.conversationId,
      callerSub: opts.callerSub,
      calleeSub: opts.calleeSub,
      phase: 'ringing',
      armedAt: now,
      lastSignalAt: now,
      ringTimer,
    });
  }

  /**
   * Validate an inbound `call.signal` frame and return the authz entry if it passes, or null for
   * a silent drop. Also advances the call phase on the first callee signal (ringing → active) and
   * resets the activity timer on every valid active-phase signal.
   */
  validateAndRelay(callId: string, senderSub: string, tenantId: string): AuthzEntry | null {
    const entry = this.authzMap.get(callId);
    if (!entry) return null;
    if (entry.tenantId !== tenantId) return null;
    if (entry.callerSub !== senderSub && entry.calleeSub !== senderSub) return null;

    // First callee signal flips the call to active and upgrades the timers.
    if (entry.phase === 'ringing' && senderSub === entry.calleeSub) {
      clearTimeout(entry.ringTimer);
      entry.phase = 'active';
      entry.maxDurationTimer = setTimeout(
        () => this.expireEntry(callId, 'peer-gone'),
        MAX_CALL_DURATION_MS,
      );
    }

    // Reset inactivity timer on every valid signal, but only once active — the ring timer covers
    // the ringing phase and should not be extendable by caller signals before the callee answers.
    if (entry.phase === 'active') {
      if (entry.activityTimer) clearTimeout(entry.activityTimer);
      entry.activityTimer = setTimeout(
        () => this.expireEntry(callId, 'peer-gone'),
        CALL_SIGNAL_ACTIVITY_MS,
      );
    }
    entry.lastSignalAt = Date.now();

    return entry;
  }

  /**
   * Explicit client-driven release (call.release frame). Verifies sender is a participant before
   * clearing the entry. Always emits call.end{peer-gone} so the peer receives a server-side
   * notification — the encrypted cancel/hangup signal may have been dropped, and during ringing
   * the callee has no other way to dismiss the incoming call UI. No-op if entry is absent or
   * sender is not a participant.
   */
  release(callId: string, senderSub: string, senderTenantId: string): void {
    const entry = this.authzMap.get(callId);
    if (!entry) return;
    if (entry.tenantId !== senderTenantId) return;
    if (entry.callerSub !== senderSub && entry.calleeSub !== senderSub) return;
    this.clearEntry(callId, entry);
    this.bus.emitCallEnd({
      tenantId: entry.tenantId,
      callId,
      conversationId: entry.conversationId,
      reason: 'peer-gone',
      callerSub: entry.callerSub,
      calleeSub: entry.calleeSub,
    });
  }

  private expireEntry(callId: string, reason: 'timeout' | 'peer-gone'): void {
    const entry = this.authzMap.get(callId);
    if (!entry) return;
    this.clearEntry(callId, entry);
    this.bus.emitCallEnd({
      tenantId: entry.tenantId,
      callId,
      conversationId: entry.conversationId,
      reason,
      callerSub: entry.callerSub,
      calleeSub: entry.calleeSub,
    });
  }

  private clearEntry(callId: string, entry: AuthzEntry): void {
    clearTimeout(entry.ringTimer);
    if (entry.activityTimer) clearTimeout(entry.activityTimer);
    if (entry.maxDurationTimer) clearTimeout(entry.maxDurationTimer);
    this.authzMap.delete(callId);
  }
}
