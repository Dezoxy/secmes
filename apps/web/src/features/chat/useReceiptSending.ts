import { useEffect, useRef, useState } from 'react';

import { recordReceipt } from '../../lib/api';
import { isReadReceiptsEnabled } from '../settings/privacy-settings';
import { nextReceiptToPost } from './receipts';
import { currentUser, type Conversation } from './seed';

interface UseReceiptSendingOptions {
  conversations: Conversation[];
  /** Ids of LIVE (real server) conversations — demo/seed conversations never POST receipts. */
  liveIds: ReadonlySet<string>;
  selectedId: string | null;
  selectedIsLive: boolean;
  /**
   * Set to false to skip the delivered-receipt loop. Use in per-screen hooks when ChatProvider
   * already handles delivered receipts globally, so only the read-receipt effect runs.
   * @default true
   */
  sendDelivered?: boolean;
}

/**
 * The RECEIVER half of delivery receipts (checkpoint 31): advance our own watermark so the sender's ticks
 * flip. Pure decisions live in `nextReceiptToPost`; this hook is just the orchestration + transport.
 *
 *  - `delivered`: for EVERY live conversation, ack the newest incoming message — so a sender sees ✓✓ even
 *    if we're looking at another chat. Always sent (delivered isn't privacy-sensitive).
 *  - `read`: only for the OPEN + focused conversation, and only when read receipts are enabled (reciprocal
 *    privacy — the matching display cap is in `foldOwnMessageStatuses`).
 *
 * Posts are deduped per conversation (a ref of the last watermark posted) so we don't spam POST /receipts;
 * a failed post clears the dedup entry so the next change retries.
 */
export function useReceiptSending({
  conversations,
  liveIds,
  selectedId,
  selectedIsLive,
  sendDelivered = true,
}: UseReceiptSendingOptions): void {
  const lastDelivered = useRef(new Map<string, string>());
  const lastRead = useRef(new Map<string, string>());
  // Bumped on tab focus / visibility change so the `read` effect re-checks when the user returns.
  const [focusTick, setFocusTick] = useState(0);

  useEffect(() => {
    const bump = (): void => setFocusTick((n) => n + 1);
    window.addEventListener('focus', bump);
    document.addEventListener('visibilitychange', bump);
    return () => {
      window.removeEventListener('focus', bump);
      document.removeEventListener('visibilitychange', bump);
    };
  }, []);

  // delivered — every live conversation, newest incoming message.
  useEffect(() => {
    if (!sendDelivered) return;
    for (const conv of conversations) {
      if (!liveIds.has(conv.id)) continue;
      const target = nextReceiptToPost(
        conv.messages,
        currentUser.id,
        lastDelivered.current.get(conv.id) ?? null,
      );
      if (!target) continue;
      lastDelivered.current.set(conv.id, target);
      void recordReceipt(conv.id, 'delivered', target).catch(() => {
        if (lastDelivered.current.get(conv.id) === target) lastDelivered.current.delete(conv.id);
      });
    }
  }, [conversations, liveIds, sendDelivered]);

  // read — only the open, focused conversation, gated by the privacy toggle.
  useEffect(() => {
    if (!selectedId || !selectedIsLive) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (!isReadReceiptsEnabled()) return;
    const conv = conversations.find((c) => c.id === selectedId);
    if (!conv) return;
    const target = nextReceiptToPost(
      conv.messages,
      currentUser.id,
      lastRead.current.get(selectedId) ?? null,
    );
    if (!target) return;
    lastRead.current.set(selectedId, target);
    void recordReceipt(selectedId, 'read', target).catch(() => {
      if (lastRead.current.get(selectedId) === target) lastRead.current.delete(selectedId);
    });
  }, [conversations, selectedId, selectedIsLive, focusTick]);
}
