import { describe, it, expect } from 'vitest';

import { foldOwnMessageStatuses, nextReceiptToPost, type PeerWatermarks } from './receipts';
import type { Message, MessageStatus } from './seed';

const ME = 'me';
const PEER = 'peer';

const msg = (id: string, senderId: string, status: MessageStatus = 'sent'): Message => ({
  id,
  senderId,
  content: 'x',
  timestamp: new Date(0),
  status,
});

// Ordered oldest→newest: own m1, own m2, peer p1.
const convo = (): Message[] => [msg('m1', ME), msg('m2', ME), msg('p1', PEER, 'read')];

const wm = (delivered: string | null, read: string | null): PeerWatermarks => ({
  deliveredThroughMessageId: delivered,
  readThroughMessageId: read,
});

describe('foldOwnMessageStatuses', () => {
  it('upgrades own messages to delivered/read by the peer watermark', () => {
    const out = foldOwnMessageStatuses(convo(), ME, wm('m2', 'm1'), true);
    expect(out.find((m) => m.id === 'm1')?.status).toBe('read'); // <= read watermark
    expect(out.find((m) => m.id === 'm2')?.status).toBe('delivered'); // <= delivered, > read
    expect(out.find((m) => m.id === 'p1')?.status).toBe('read'); // incoming — untouched
  });

  it('never downgrades a real send state (watermark only moves ticks forward)', () => {
    // No watermarks → an already-delivered own message stays delivered, not back to sent.
    const messages = [msg('m1', ME, 'delivered')];
    const out = foldOwnMessageStatuses(messages, ME, wm(null, null), true);
    expect(out[0]?.status).toBe('delivered');
  });

  it('never overwrites failed or sending', () => {
    const messages = [msg('m1', ME, 'failed'), msg('m2', ME, 'sending')];
    const out = foldOwnMessageStatuses(messages, ME, wm('m2', 'm2'), true);
    expect(out[0]?.status).toBe('failed');
    expect(out[1]?.status).toBe('sending');
  });

  it('reciprocal cap: with my read receipts off, read is clamped to delivered', () => {
    const out = foldOwnMessageStatuses(convo(), ME, wm('m2', 'm2'), false);
    expect(out.find((m) => m.id === 'm1')?.status).toBe('delivered'); // would be read if enabled
    expect(out.find((m) => m.id === 'm2')?.status).toBe('delivered');
  });

  it('caps an already-read own message down to delivered when read receipts are off', () => {
    const messages = [msg('m1', ME, 'read')];
    const out = foldOwnMessageStatuses(messages, ME, wm('m1', 'm1'), false);
    expect(out[0]?.status).toBe('delivered');
  });

  it('a watermark for an unloaded message contributes nothing (no false upgrade)', () => {
    const out = foldOwnMessageStatuses(convo(), ME, wm('not-loaded', null), true);
    expect(out.find((m) => m.id === 'm1')?.status).toBe('sent');
    expect(out.find((m) => m.id === 'm2')?.status).toBe('sent');
  });

  it('is idempotent', () => {
    const once = foldOwnMessageStatuses(convo(), ME, wm('m2', 'm1'), true);
    const twice = foldOwnMessageStatuses(once, ME, wm('m2', 'm1'), true);
    expect(twice.map((m) => m.status)).toEqual(once.map((m) => m.status));
  });
});

describe('nextReceiptToPost', () => {
  it('returns the newest incoming message id', () => {
    expect(nextReceiptToPost(convo(), ME, null)).toBe('p1');
  });

  it('dedups: returns null when the newest incoming was already posted', () => {
    expect(nextReceiptToPost(convo(), ME, 'p1')).toBeNull();
  });

  it('returns null when there are no incoming messages', () => {
    expect(nextReceiptToPost([msg('m1', ME), msg('m2', ME)], ME, null)).toBeNull();
  });

  it('picks the newest incoming even when own messages follow it', () => {
    const messages = [msg('p1', PEER), msg('p2', PEER), msg('m1', ME)];
    expect(nextReceiptToPost(messages, ME, null)).toBe('p2');
  });
});
