import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InProcessRealtimeBus } from '../realtime/in-process-realtime-bus.js';
import { CallsAuthzService } from './calls-authz.service.js';

const CALL_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CONV = '550e8400-e29b-41d4-a716-446655440000';

describe('CallsAuthzService', () => {
  let bus: InProcessRealtimeBus;
  let svc: CallsAuthzService;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new InProcessRealtimeBus();
    svc = new CallsAuthzService(bus);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function register(opts: { callerSub?: string; calleeSub?: string } = {}): void {
    svc.register(CALL_ID, {
      tenantId: 'T1',
      conversationId: CONV,
      callerSub: opts.callerSub ?? 'caller',
      calleeSub: opts.calleeSub ?? 'callee',
    });
  }

  it('release emits call.end{peer-gone} so a ringing callee can dismiss the incoming call UI', () => {
    register();

    const ends: unknown[] = [];
    bus.onCallEnd((e) => ends.push(e));

    svc.release(CALL_ID, 'caller', 'T1');

    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      callId: CALL_ID,
      reason: 'peer-gone',
      callerSub: 'caller',
      calleeSub: 'callee',
    });
  });

  it('release is a no-op when the entry is already gone', () => {
    const ends: unknown[] = [];
    bus.onCallEnd((e) => ends.push(e));

    svc.release(CALL_ID, 'caller', 'T1'); // no entry registered

    expect(ends).toHaveLength(0);
  });

  it('release rejects a sender that is not a participant', () => {
    register();

    const ends: unknown[] = [];
    bus.onCallEnd((e) => ends.push(e));

    svc.release(CALL_ID, 'intruder', 'T1');

    expect(ends).toHaveLength(0);
  });

  it('release rejects a cross-tenant sender', () => {
    register();

    const ends: unknown[] = [];
    bus.onCallEnd((e) => ends.push(e));

    svc.release(CALL_ID, 'caller', 'T2'); // wrong tenant

    expect(ends).toHaveLength(0);
  });

  it('ring timeout emits call.end{timeout} after 45 s', () => {
    register();

    const ends: unknown[] = [];
    bus.onCallEnd((e) => ends.push(e));

    vi.advanceTimersByTime(45_000);

    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ callId: CALL_ID, reason: 'timeout' });
  });

  it('validateAndRelay: rejects a mismatched conversationId before mutating phase', () => {
    register();

    const result = svc.validateAndRelay(
      CALL_ID,
      'caller',
      'T1',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc', // wrong conversation
    );

    expect(result).toBeNull();
    // Entry still exists with original phase (no mutation occurred).
    const correct = svc.validateAndRelay(CALL_ID, 'caller', 'T1', CONV);
    expect(correct).not.toBeNull();
    expect(correct?.phase).toBe('ringing'); // phase unchanged by the rejected call
  });

  it('releaseByParticipants: emits call.end{peer-gone} for entries matching caller sub', () => {
    register();

    const ends: unknown[] = [];
    bus.onCallEnd((e) => ends.push(e));

    svc.releaseByParticipants('T1', ['caller']);

    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ callId: CALL_ID, reason: 'peer-gone' });
  });

  it('releaseByParticipants: tenant isolation — does not release cross-tenant entries', () => {
    register();

    const ends: unknown[] = [];
    bus.onCallEnd((e) => ends.push(e));

    svc.releaseByParticipants('T2', ['caller']); // wrong tenant

    expect(ends).toHaveLength(0);
  });
});
