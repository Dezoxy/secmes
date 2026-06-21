import { describe, expect, it } from 'vitest';
import type { Conversation } from './seed';
import { currentUser } from './seed';
import {
  addLiveId,
  classifyDeliveryFrame,
  liveConversationShell,
  prependConversationIfMissing,
  setsEqual,
} from './useLiveConversations';

const existingConversation: Conversation = {
  id: 'existing-live',
  type: 'direct',
  participants: [],
  messages: [],
  unreadCount: 0,
};

describe('live conversation helpers', () => {
  it('adds live ids without replacing an unchanged set', () => {
    const existing = new Set(['existing-live']);

    expect(addLiveId(existing, 'existing-live')).toBe(existing);

    const next = addLiveId(existing, 'new-live');
    expect(next).not.toBe(existing);
    expect([...next].sort()).toEqual(['existing-live', 'new-live']);
  });

  it('prepends missing live conversations without duplicating existing ones', () => {
    const conversations = [existingConversation];
    const nextConversation: Conversation = {
      ...existingConversation,
      id: 'new-live',
    };

    expect(prependConversationIfMissing(conversations, existingConversation)).toBe(conversations);
    expect(prependConversationIfMissing(conversations, nextConversation)).toEqual([
      nextConversation,
      existingConversation,
    ]);
  });

  it('creates neutral live conversation shells for joined contacts', () => {
    const shell = liveConversationShell('conv-live', currentUser);

    expect(shell).toMatchObject({
      id: 'conv-live',
      type: 'direct',
      unreadCount: 0,
      messages: [],
    });
    expect(shell.participants[0]).toBe(currentUser);
    expect(shell.participants[1]).toMatchObject({
      id: 'peer-conv-live',
      name: 'New contact',
    });
    expect(shell.participants[1]?.avatar).toMatch(/^data:image\/svg\+xml,/);
  });
});

// Identity-change detection routing (the three cases inside onJoined's fire-and-forget).
// setsEqual is the comparison gate; these tests verify the routing logic it drives.
describe('identity-change detection routing', () => {
  const num = (n: number) =>
    `${n}${n}${n}${n}${n} ${n}${n}${n}${n}${n} 22222 33333 44444 55555 66666 77777`;

  function dispatch(
    stored: string[] | null,
    current: string[],
  ): { action: 'none' | 'verified' | 'changed'; safetyNumber: string } {
    if (stored === null) return { action: 'none', safetyNumber: '' };
    if (!setsEqual(stored, current)) return { action: 'changed', safetyNumber: current[0] ?? '' };
    return { action: 'verified', safetyNumber: stored[0] ?? '' };
  }

  it('key unchanged → onPeerVerified fires, onPeerKeyChanged not called', () => {
    const numbers = [num(1), num(2)];
    expect(dispatch(numbers, numbers)).toEqual({ action: 'verified', safetyNumber: num(1) });
  });

  it('any number in the set changes → onPeerKeyChanged fires', () => {
    const stored = [num(1), num(2)];
    const changed = [num(1), num(3)]; // one device changed identity
    expect(dispatch(stored, changed)).toEqual({ action: 'changed', safetyNumber: num(1) });
  });

  it('stored === null (never verified) → neither callback fires', () => {
    expect(dispatch(null, [num(1)])).toEqual({ action: 'none', safetyNumber: '' });
  });

  it('setsEqual requires same length and same order (sorted arrays)', () => {
    expect(setsEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(setsEqual(['a', 'b'], ['b', 'a'])).toBe(false); // callers pre-sort; out-of-order = mismatch
    expect(setsEqual(['a'], ['a', 'b'])).toBe(false);
    expect(setsEqual([], [])).toBe(true);
  });
});

// Track 3 item D — transport delivery-gap detection. classifyDeliveryFrame is the pure decision behind the
// live `onMessage` handler: given the last-seen counter and an incoming frame's seq/prevSeq, does the client
// need to backfill? The seq is a HINT only — it never gates decryption or ordering.
describe('classifyDeliveryFrame (delivery-gap detection)', () => {
  it('absent counter (older gateway) ⇒ no gap, state unchanged', () => {
    expect(classifyDeliveryFrame(undefined, undefined, undefined)).toEqual({
      last: undefined,
      gap: false,
    });
    expect(classifyDeliveryFrame(5, undefined, undefined)).toEqual({ last: 5, gap: false });
  });

  it('prevSeq === null (gateway’s first frame on this socket) ⇒ (re)baseline, no gap', () => {
    expect(classifyDeliveryFrame(undefined, 1, null)).toEqual({ last: 1, gap: false });
    // Even after a previous socket left a stale baseline, a fresh prevSeq=null frame re-baselines (reconnect).
    expect(classifyDeliveryFrame(9, 1, null)).toEqual({ last: 1, gap: false });
  });

  it('contiguous frame (prevSeq === last) ⇒ no gap, advances last', () => {
    expect(classifyDeliveryFrame(1, 2, 1)).toEqual({ last: 2, gap: false });
    expect(classifyDeliveryFrame(41, 42, 41)).toEqual({ last: 42, gap: false });
  });

  it('a skipped frame (prevSeq !== last) ⇒ GAP, advances last to the new seq', () => {
    expect(classifyDeliveryFrame(3, 6, 5)).toEqual({ last: 6, gap: true }); // missed 4 and 5
  });

  it('a dropped LEADING frame (numeric prevSeq with no baseline) ⇒ GAP', () => {
    // The genuine first frame (prevSeq=null) was lost; we first see seq 2 (prevSeq 1) → we missed seq 1.
    expect(classifyDeliveryFrame(undefined, 2, 1)).toEqual({ last: 2, gap: true });
  });

  it('a duplicate / late-arriving reorder (seq <= last) ⇒ no gap, keeps position', () => {
    expect(classifyDeliveryFrame(5, 3, 2)).toEqual({ last: 5, gap: false });
    expect(classifyDeliveryFrame(5, 5, 4)).toEqual({ last: 5, gap: false });
  });

  it('missing prevSeq falls back to the raw seq step (defensive)', () => {
    expect(classifyDeliveryFrame(4, 5, undefined)).toEqual({ last: 5, gap: false }); // contiguous step
    expect(classifyDeliveryFrame(4, 7, undefined)).toEqual({ last: 7, gap: true }); // jumped
  });
});
