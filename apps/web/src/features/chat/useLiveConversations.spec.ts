import { describe, expect, it } from 'vitest';
import type { Conversation } from './seed';
import { currentUser } from './seed';
import {
  addLiveId,
  classifyCommitDrain,
  classifyDeliveryFrame,
  foldConversationsFromPeerWatermarks,
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

  it('re-folds stored peer read watermarks when read receipts become enabled', () => {
    const conversations: Conversation[] = [
      {
        id: 'conv-live',
        type: 'direct',
        participants: [],
        unreadCount: 0,
        messages: [
          {
            id: 'm1',
            senderId: currentUser.id,
            content: 'ciphertext decrypted locally',
            timestamp: new Date('2026-01-01T00:00:00.000Z'),
            status: 'sent',
          },
        ],
      },
    ];
    const peerWatermarks = new Map([
      ['conv-live', { deliveredThroughMessageId: 'm1', readThroughMessageId: 'm1' }],
    ]);

    const capped = foldConversationsFromPeerWatermarks(
      conversations,
      currentUser.id,
      peerWatermarks,
      false,
    );
    expect(capped[0]?.messages[0]?.status).toBe('delivered');

    const uncapped = foldConversationsFromPeerWatermarks(
      capped,
      currentUser.id,
      peerWatermarks,
      true,
    );
    expect(uncapped[0]?.messages[0]?.status).toBe('read');
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

// Track 4 slice 5b — commit-drain classification. classifyCommitDrain is the pure decision behind the
// catch-up loop / onCommit handler: a drain that COULDN'T advance is either a transient stall (retry) or a
// genuine, unrecoverable gap (sync-lost → recovery). The oldest retained commit epoch (5a header) decides:
// if the commit that would advance the group (stamped at the local epoch) is already pruned, retrying is
// futile. The epoch is metadata only — it never gates decryption or ordering.
describe('classifyCommitDrain (sync-lost detection)', () => {
  it('already at/past the target ⇒ in-sync (guard; callers only call this on a stall)', () => {
    expect(classifyCommitDrain({ localEpoch: 5, targetEpoch: 5, oldestRetainedEpoch: 0 })).toBe(
      'in-sync',
    );
    expect(classifyCommitDrain({ localEpoch: 6, targetEpoch: 5, oldestRetainedEpoch: null })).toBe(
      'in-sync',
    );
  });

  it('behind, and the needed commit is PRUNED (oldest retained > local) ⇒ sync-lost', () => {
    // local at epoch 2 needs the commit stamped at epoch 2; the server's oldest retained is 5 → it's gone.
    expect(classifyCommitDrain({ localEpoch: 2, targetEpoch: 6, oldestRetainedEpoch: 5 })).toBe(
      'sync-lost',
    );
    // Boundary: oldest retained is exactly local+1 — the local-epoch commit is already gone.
    expect(classifyCommitDrain({ localEpoch: 2, targetEpoch: 3, oldestRetainedEpoch: 3 })).toBe(
      'sync-lost',
    );
  });

  it('behind, but the needed commit is still retained (oldest retained ≤ local) ⇒ transient', () => {
    // oldest retained == local: the commit stamped at the local epoch is still there — just not applied yet.
    expect(classifyCommitDrain({ localEpoch: 2, targetEpoch: 5, oldestRetainedEpoch: 2 })).toBe(
      'transient',
    );
    expect(classifyCommitDrain({ localEpoch: 4, targetEpoch: 5, oldestRetainedEpoch: 0 })).toBe(
      'transient',
    );
  });

  it('behind, server reported no oldest epoch (null — old server / no rows) ⇒ transient, never a false gap', () => {
    expect(classifyCommitDrain({ localEpoch: 2, targetEpoch: 5, oldestRetainedEpoch: null })).toBe(
      'transient',
    );
  });
});
