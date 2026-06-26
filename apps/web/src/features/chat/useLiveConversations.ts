import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { Conversation as MlsGroup, DeviceKeys } from '@argus/crypto';
import { accessToken } from '../../lib/auth';
import { fetchReceipts, listEnrollments, listMyConversations } from '../../lib/api';
import { enrollDevice } from '../../lib/enroll';
import { joinPendingConversations } from '../../lib/join';
import {
  receiveLiveMessage,
  processCommitEvent,
  type DecryptedMessage,
  type MessagingDeps,
} from '../../lib/messaging';
import {
  createMessageSocket,
  type IncomingReceipt,
  type MessageSocket,
  type MessageSocketStatus,
} from '../../lib/ws';
import { isReadReceiptsEnabled } from '../settings/privacy-settings';
import {
  persistPeerMapping,
  placeholderPeerId,
  resolvePeerUser,
  withPeerNamed,
} from './peer-naming';
import { foldOwnMessageStatuses, type PeerWatermarks } from './receipts';
import type { Conversation, User } from './seed';
import { currentUser, generatedAvatar } from './seed';

// Coalescing window for transport-gap backfills (Track 3 item D). A burst of out-of-order/dropped live
// frames in one conversation collapses into a single catch-up fetch rather than one per frame — bounds the
// self-inflicted REST load and avoids a backfill storm on a flaky link.
const GAP_BACKFILL_DEBOUNCE_MS = 250;

// Track 4 slice 5b — bounded transient-stall budget for the catch-up loop. When a drain can't advance but
// the needed commit is NOT pruned (classifyCommitDrain → 'transient'), the commit may simply not be
// GET-visible yet (e.g. replication lag). Retry a few times with a short delay; if it still won't advance,
// stop and let the next commit event / reconnect re-drive — never spin forever (the bug 5b fixes).
const CATCHUP_MAX_TRANSIENT_STALLS = 3;
const CATCHUP_RETRY_DELAY_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Track 4 slice 5b — classify a STALLED commit drain (one that couldn't reach `targetEpoch`) as a
 * transient stall (retry) or a genuine, unrecoverable gap (`sync-lost`). Pure, mirroring
 * `classifyDeliveryFrame`. The deciding fact is the server's oldest still-retained commit epoch:
 *
 *  - `in-sync`    — the local epoch already reached the target (a guard; callers only call this on a stall).
 *  - `sync-lost`  — the commit that would advance the group (the one stamped at `localEpoch`) is GONE: the
 *                   server's oldest retained commit is already past `localEpoch`, so retrying can never
 *                   close the gap. Recovery (re-add via Welcome, 5c) is required. This is exactly the state
 *                   contiguity-preserving prefix pruning (5e) produces, and the "offline beyond retention"
 *                   case.
 *  - `transient`  — the needed commit is still retained (or the server reported no oldest epoch): the stall
 *                   is momentary; retry within a bounded budget.
 *
 * `oldestRetainedEpoch` is metadata only (an integer epoch); it never gates decryption or ordering.
 */
export type CommitSyncState = 'in-sync' | 'transient' | 'sync-lost';

export function classifyCommitDrain(args: {
  localEpoch: number;
  targetEpoch: number;
  oldestRetainedEpoch: number | null;
}): CommitSyncState {
  const { localEpoch, targetEpoch, oldestRetainedEpoch } = args;
  if (localEpoch >= targetEpoch) return 'in-sync';
  if (oldestRetainedEpoch !== null && oldestRetainedEpoch > localEpoch) return 'sync-lost';
  return 'transient';
}

/**
 * Decide what a `message` frame's transport delivery counter implies for gap detection (Track 3 item D).
 * Pure: given the last-seen deliverySeq for a conversation and this frame's deliverySeq/deliveryPrevSeq,
 * return the new last-seen value and whether a live frame was missed (→ re-fetch over the existing backfill).
 * The counter is a HINT only — it never gates decryption or ordering (MLS + the (created_at,id) cursor own
 * those). Rules:
 *  - absent deliverySeq ⇒ detection unavailable (older gateway): keep state, no gap.
 *  - deliveryPrevSeq === null ⇒ the gateway's first frame on this socket+room: (re)baseline, no gap.
 *  - deliverySeq <= last ⇒ duplicate / late-arriving reorder: keep position, no gap (dedup-by-id covers content).
 *  - otherwise contiguous iff deliveryPrevSeq === last; a numeric prevSeq with no baseline (we never saw the
 *    leading frame(s)) is therefore a gap. A missing prevSeq falls back to the raw seq step (seq === last+1).
 */
export function classifyDeliveryFrame(
  last: number | undefined,
  deliverySeq: number | undefined,
  deliveryPrevSeq: number | null | undefined,
): { last: number | undefined; gap: boolean } {
  if (typeof deliverySeq !== 'number') return { last, gap: false };
  if (deliveryPrevSeq === null) return { last: deliverySeq, gap: false };
  if (last !== undefined && deliverySeq <= last) return { last, gap: false };
  const contiguous =
    typeof deliveryPrevSeq === 'number'
      ? last !== undefined && deliveryPrevSeq === last
      : last !== undefined && deliverySeq === last + 1;
  return { last: deliverySeq, gap: !contiguous };
}

interface UseLiveConversationsOptions {
  device: DeviceKeys | null;
  pool: DeviceKeys[] | null;
  deviceId: string | null;
  messagingDeps: MessagingDeps | null;
  selfUserId: string | undefined;
  currentUserProfile: User;
  mergeIncoming: (conversationId: string, incoming: DecryptedMessage[]) => void;
  backfillInto: (
    conversationId: string,
    group: MlsGroup,
    selfUserId: string,
  ) => Promise<{ nextEpoch: number | undefined }> | void;
  setConversations: Dispatch<SetStateAction<Conversation[]>>;
  /** Called when another device of this user registers a pending enrollment request (D1 side). */
  onEnrollmentPending?: (enrollmentId: string) => void;
  /** Called when this device's enrollment is approved (D2 side). */
  onEnrollmentApproved?: (enrollmentId: string) => void;
  /** Called when a new incoming friend request arrived — caller should refresh incoming requests. */
  onFriendRequest?: () => void;
  /**
   * Called when a joined conversation's peer safety numbers differ from the stored verified set —
   * the peer has a new cryptographic identity (reinstall or device replacement). The UI should
   * clear the verified badge and open the re-verify prompt.
   */
  onPeerKeyChanged?: (peerUserId: string, conversationId: string, newNumbers: string[]) => void;
  /**
   * Called when a joined conversation's peer safety numbers exactly match the stored verified set —
   * the peer's identity is unchanged; restore the verified state immediately (no prompt needed).
   */
  onPeerVerified?: (conversationId: string, safetyNumber: string) => void;
  /**
   * Called with the resolved safety number for any joined conversation that has computable safety
   * numbers. Feeds numbersByConv so the Verify button shows the correct number.
   */
  onSafetyNumberResolved?: (conversationId: string, safetyNumber: string) => void;
  /**
   * Track 4 slice 5b/5c — called when a conversation is detected as "sync-lost": the commit needed to
   * advance its MLS epoch has been pruned (or the device was offline beyond retention), so catch-up can
   * never close the gap by retrying. The argument is the conversation id (metadata only). This is the
   * UI signal — the consumer (5c) stamps an "out of sync" affordance on the conversation. The hook also
   * drops the doomed group from `liveGroups` so the live paths stop attempting it (see `signalSyncLost`).
   * The actual RECOVERY (re-add the device via the member/Welcome path so it re-joins fresh) is slice
   * 5c-2 — a stranded device can't re-add itself, and nothing produces a fresh Welcome for an
   * already-rostered device today, so v1 surfaces the state rather than promising auto-recovery.
   */
  onSyncLost?: (conversationId: string) => void;
}

interface UseLiveConversationsResult {
  liveIds: Set<string>;
  liveGroups: { current: Map<string, MlsGroup> };
  addLive: (conversationId: string, conversation: MlsGroup) => void;
  connectionStatus: MessageSocketStatus;
  refoldPeerReceiptWatermarks: () => void;
}

export function liveConversationShell(conversationId: string, selfUser: User): Conversation {
  return {
    id: conversationId,
    type: 'direct',
    participants: [
      selfUser,
      {
        // A neutral placeholder until the peer resolves via the directory (see peer-naming.ts — joins name
        // it from the welcome's senderUserId; history/incoming messages name it from their senderUserId).
        // No isOnline: presence is UNKNOWN for live peers — never claim Offline without a presence system.
        id: placeholderPeerId(conversationId),
        name: 'New contact',
        avatar: generatedAvatar(conversationId),
      },
    ],
    messages: [],
    unreadCount: 0,
  };
}

export function addLiveId(previous: Set<string>, conversationId: string): Set<string> {
  return previous.has(conversationId) ? previous : new Set(previous).add(conversationId);
}

export function foldConversationsFromPeerWatermarks(
  conversations: Conversation[],
  selfUserId: string,
  peerWatermarks: ReadonlyMap<string, PeerWatermarks>,
  readReceiptsEnabled: boolean,
): Conversation[] {
  return conversations.map((conversation) => {
    const watermarks = peerWatermarks.get(conversation.id);
    if (!watermarks) return conversation;

    const messages = foldOwnMessageStatuses(
      conversation.messages,
      selfUserId,
      watermarks,
      readReceiptsEnabled,
    );
    const changed = messages.some((message, index) => message !== conversation.messages[index]);
    return changed ? { ...conversation, messages } : conversation;
  });
}

export function prependConversationIfMissing(
  conversations: Conversation[],
  conversation: Conversation,
): Conversation[] {
  return conversations.some((item) => item.id === conversation.id)
    ? conversations
    : [conversation, ...conversations];
}

/** Replace an existing entry by id, or prepend if not present. Use for live paths that are the
 * ground truth — ensures a roster-recovery placeholder is replaced when the MLS group becomes live. */
export function replaceOrPrependConversation(
  conversations: Conversation[],
  conversation: Conversation,
): Conversation[] {
  const idx = conversations.findIndex((c) => c.id === conversation.id);
  if (idx === -1) return [conversation, ...conversations];
  const next = [...conversations];
  next[idx] = conversation;
  return next;
}

export function setsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function useLiveConversations({
  device,
  pool,
  deviceId,
  messagingDeps,
  selfUserId,
  currentUserProfile,
  mergeIncoming,
  backfillInto,
  setConversations,
  onEnrollmentPending,
  onEnrollmentApproved,
  onFriendRequest,
  onPeerKeyChanged,
  onPeerVerified,
  onSafetyNumberResolved,
  onSyncLost,
}: UseLiveConversationsOptions): UseLiveConversationsResult {
  const [liveIds, setLiveIds] = useState<Set<string>>(() => new Set());
  const [connectionStatus, setConnectionStatus] = useState<MessageSocketStatus>('offline');
  const liveGroups = useRef(new Map<string, MlsGroup>());
  const socketRef = useRef<MessageSocket | null>(null);
  const joinRanRef = useRef(false);
  // Serialize drains: joinPendingConversations is idempotent but must not run CONCURRENTLY with itself
  // (two drains could race the same one-time private). A nudge that lands mid-drain queues exactly one
  // re-run — the in-flight drain's welcome list may predate the nudge's Welcome.
  const drainStateRef = useRef({ running: false, queued: false });
  // The SESSION's shrinking working pool. The provider's `pool` is set once at unlock and never pruned;
  // each drain consumes one-time privates and prunes only the sealed keystore — so without a session copy a
  // later drain would re-pass already-spent packages and could re-open a replayed Welcome (FS break). We
  // seed from the prop, shrink it via `onSpent`, and re-seed when the provider publishes a new pool.
  const poolWorkingRef = useRef<DeviceKeys[] | null>(null);
  const poolSourceRef = useRef<DeviceKeys[] | null>(null);
  // Latest drain in a ref so the long-lived socket can call it without being torn down on re-renders.
  const drainRef = useRef<() => void>(() => {});

  // The PEER's latest delivered/read watermarks per conversation (checkpoint 31). Seeded from GET /receipts
  // on subscribe and advanced by live `receipt` WS frames; folded onto our own messages to drive ticks.
  const peerWatermarks = useRef(new Map<string, PeerWatermarks>());

  // Transport delivery-gap detection (Track 3 item D). lastDeliverySeq holds the last per-(socket,
  // conversation) `deliverySeq` we saw; a non-contiguous next frame means a live frame was dropped/reordered.
  // We STILL decrypt the live frame inline (the WS frame is the reliable copy and is never discarded) and,
  // on a detected gap, ALSO schedule a debounced backfill to recover the missed EARLIER frame over the
  // existing catch-up path. gapBackfillTimers coalesces a burst of gaps per conversation into one fetch. The
  // seq is a HINT only — it never gates decryption or ordering (MLS + the (created_at,id) cursor own those);
  // it carries no cryptographic guarantee. Both reset on (re)subscribe and on removal.
  const lastDeliverySeq = useRef(new Map<string, number>());
  const gapBackfillTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const addLive = useCallback((conversationId: string, conversation: MlsGroup): void => {
    liveGroups.current.set(conversationId, conversation);
    setLiveIds((prev) => addLiveId(prev, conversationId));
    socketRef.current?.subscribe(conversationId);
  }, []);

  // Re-fold a conversation's OWN message ticks from the stored peer watermark. Reads the read-receipt
  // toggle live so flipping it in settings caps/uncaps the peer's `read` ticks on the next event.
  const foldConversation = useCallback(
    (conversationId: string): void => {
      const wm = peerWatermarks.current.get(conversationId);
      if (!wm) return;
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                messages: foldOwnMessageStatuses(
                  c.messages,
                  currentUser.id,
                  wm,
                  isReadReceiptsEnabled(),
                ),
              }
            : c,
        ),
      );
    },
    [setConversations],
  );

  const refoldPeerReceiptWatermarks = useCallback((): void => {
    setConversations((prev) =>
      foldConversationsFromPeerWatermarks(
        prev,
        currentUser.id,
        peerWatermarks.current,
        isReadReceiptsEnabled(),
      ),
    );
  }, [setConversations]);

  // A live receipt advance from the gateway. Ignore our OWN echo (the gateway fans a receipt to the whole
  // room, including the actor) — only the PEER's watermark moves our ticks.
  const applyReceipt = useCallback(
    ({ conversationId, userId, status, throughMessageId }: IncomingReceipt): void => {
      if (userId === selfUserId) return;
      const prev = peerWatermarks.current.get(conversationId) ?? {
        deliveredThroughMessageId: null,
        readThroughMessageId: null,
      };
      peerWatermarks.current.set(conversationId, {
        ...prev,
        ...(status === 'delivered'
          ? { deliveredThroughMessageId: throughMessageId }
          : { readThroughMessageId: throughMessageId }),
      });
      foldConversation(conversationId);
    },
    [foldConversation, selfUserId],
  );

  // Seed initial tick state when a conversation's room is joined: GET the per-member watermarks once so
  // history shows correct delivered/read (the live `receipt` frames refine it afterward). Best-effort.
  const seedReceipts = useCallback(
    (conversationId: string): void => {
      if (!selfUserId) return;
      void fetchReceipts(conversationId)
        .then((rows) => {
          const peer = rows.find((r) => r.userId !== selfUserId);
          if (!peer) return;
          peerWatermarks.current.set(conversationId, {
            deliveredThroughMessageId: peer.deliveredThroughMessageId,
            readThroughMessageId: peer.readThroughMessageId,
          });
          foldConversation(conversationId);
        })
        .catch(() => {
          // best-effort: ticks stay at their send state until a live receipt frame arrives
        });
    },
    [foldConversation, selfUserId],
  );

  // Drain pending Welcomes (Slice 4 + 5B): runs on connect AND whenever the gateway pushes a live
  // `welcome` nudge (someone added us to a conversation while we're connected — without the nudge the
  // new conversation would stay invisible until the next reconnect).
  const drainWelcomes = useCallback((): void => {
    if (!device || !pool || !deviceId || !messagingDeps) return;
    const drainState = drainStateRef.current;
    if (drainState.running) {
      drainState.queued = true;
      return;
    }
    // Seed/re-seed the session working pool only when no drain is in flight, so we never swap the array a
    // running drain's onSpent is pruning. Stable across the session; re-seeds only on a fresh unlock/restore.
    if (poolSourceRef.current !== pool) {
      poolSourceRef.current = pool;
      poolWorkingRef.current = [...pool];
    }
    const sessionPool = poolWorkingRef.current;
    if (!sessionPool) return; // seeded above whenever `pool` changed — type guard, never hit at runtime
    drainState.running = true;
    joinPendingConversations({
      device,
      pool: sessionPool,
      deviceId,
      keystore: messagingDeps.keystore,
      sessionKey: messagingDeps.sessionKey,
      // A one-time private was just spent: drop it from the SESSION pool so a later live nudge's drain can't
      // resurrect it (the keystore prune doesn't touch this in-memory pool). `member` is a reference from
      // sessionPool, so identity-match is exact.
      onSpent: (member) => {
        const at = sessionPool.indexOf(member);
        if (at !== -1) sessionPool.splice(at, 1);
      },
      onJoined: ({ conversationId, conversation, senderUserId, peerSafetyNumbers }) => {
        addLive(conversationId, conversation);
        const shell = liveConversationShell(conversationId, currentUserProfile);
        setConversations((prev) => replaceOrPrependConversation(prev, shell));
        // Persist the peerUserId mapping only when the sender is the real peer — not self. In the
        // device-enrollment flow, an existing own device sends the Welcome to D2, making senderUserId
        // equal to selfUserId; persisting that would map the conversation to ourselves.
        if (senderUserId !== selfUserId) persistPeerMapping(conversationId, senderUserId);
        // Name the new conversation after the (verified) member who added us — best-effort, async; the
        // placeholder stays if the directory lookup misses.
        void resolvePeerUser(senderUserId, conversationId).then((peer) => {
          if (peer) setConversations((prev) => withPeerNamed(prev, conversationId, peer));
        });
        // Identity-change detection: compare the joined group's safety numbers against the stored set.
        // Fire-and-forget: the default (unverified) is the fail-safe state while this resolves.
        if (peerSafetyNumbers !== null && messagingDeps) {
          const primaryNumber = peerSafetyNumbers[0];
          if (primaryNumber) onSafetyNumberResolved?.(conversationId, primaryNumber);
          void messagingDeps.keystore
            .loadVerifiedPeer(senderUserId, messagingDeps.sessionKey)
            .then((stored) => {
              if (stored === null) return; // never verified — leave unverified, no forced panel open
              if (!setsEqual(stored, peerSafetyNumbers)) {
                // Delete the stale record before surfacing the prompt: if the user closes before
                // re-verifying, rehydration must NOT restore the old badge from the now-invalid row.
                void messagingDeps.keystore.deleteVerifiedPeer(senderUserId);
                onPeerKeyChanged?.(senderUserId, conversationId, peerSafetyNumbers);
              } else {
                // Same key: restore verified state immediately (no prompt needed).
                onPeerVerified?.(conversationId, peerSafetyNumbers[0] ?? '');
              }
            })
            .catch(() => {
              // treat as never verified — fail safe
            });
        }
      },
    })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('welcome drain failed', err instanceof Error ? err.message : err);
      })
      .finally(() => {
        drainState.running = false;
        if (drainState.queued) {
          drainState.queued = false;
          drainRef.current();
        }
      });
  }, [
    addLive,
    currentUserProfile,
    device,
    deviceId,
    messagingDeps,
    onPeerKeyChanged,
    onPeerVerified,
    onSafetyNumberResolved,
    pool,
    selfUserId,
    setConversations,
  ]);

  useEffect(() => {
    drainRef.current = drainWelcomes;
  }, [drainWelcomes]);

  // Join on connect: the initial drain once the device is unlocked and provisioned. Gate on selfUserId too —
  // drainWelcomes uses it to tell a peer's Welcome from our own device-enrollment Welcome (senderUserId ===
  // selfUserId). Draining before the profile resolves would capture selfUserId === undefined, so the guard
  // always passes and a self-sent enrollment Welcome gets persisted as a peer. joinRanRef latches the drain to
  // run once, so without this gate the stale-closure run could never be corrected. (Mirrors the WS-socket
  // effect below, which already requires selfUserId.)
  useEffect(() => {
    if (!device || !pool || !deviceId || !messagingDeps || !selfUserId || joinRanRef.current)
      return;
    joinRanRef.current = true;
    drainWelcomes();
  }, [device, deviceId, drainWelcomes, messagingDeps, pool, selfUserId]);

  // Realtime push (Slice 5C): one reconnecting WebSocket authenticated in the first frame.
  useEffect(() => {
    if (!messagingDeps || !selfUserId) {
      setConnectionStatus('offline');
      return;
    }
    setConnectionStatus('connecting');
    const deps = messagingDeps;

    // Track 4 slice 5c — a conversation is sync-lost (the commit it needs to advance is gone). Drop the
    // doomed group from liveGroups so the live paths stop attempting a ratchet that can never advance
    // (the other fire sites then short-circuit on their `if (!group) return` guard — idempotent across
    // all three), and signal the UI to surface the "out of sync" affordance. We deliberately do NOT
    // clear durable group state or attempt a re-join here: a stranded device can't re-add itself, and
    // nothing produces a fresh Welcome for an already-rostered device in v1 (enrollDevice skips a device
    // already in the roster). That active recovery — re-add via the member/Welcome path so it re-joins
    // fresh — is slice 5c-2. Keeping GROUP_STORE means a reload simply re-detects + re-surfaces (no
    // vanished conversation), and there is no delete to race a concurrent ratchet save.
    const signalSyncLost = (conversationId: string): void => {
      // Drop the doomed group from BOTH the in-memory group map AND the live-id set, so every live-path
      // consumer treats the conversation as no longer live: the catch-up / commit-drain / live-message
      // handlers short-circuit on `if (!group) return`, and the liveIds-keyed paths
      // (useReceiptSending, useChatState → selectedIsLive, useSelectedConversationBackfill) stop acting on
      // it — no stray delivered/read receipt POSTs or backfills for a conversation that can't advance.
      // Unlike onRemoved, we do NOT remove it from the conversation LIST: it stays visible with the "out
      // of sync" banner.
      liveGroups.current.delete(conversationId);
      setLiveIds((prev) => {
        if (!prev.has(conversationId)) return prev;
        const next = new Set(prev);
        next.delete(conversationId);
        return next;
      });
      // Durably mark sync-lost so the affordance survives a reload: otherwise a refresh would rehydrate
      // the stale group as live (banner gone, composer back) and a stale-epoch send would be
      // undecryptable. Best-effort, id-only log; the flag is preserved across any in-flight ratchet save.
      void deps.keystore
        .markConversationSyncLost(deps.device, conversationId)
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.warn(
            'mark sync-lost failed',
            conversationId,
            err instanceof Error ? err.message : err,
          );
        });
      onSyncLost?.(conversationId);
    };

    // Interleaved catch-up for one conversation: backfill at the current epoch, then — if messages at a
    // future epoch were seen — drain commits to EXACTLY that epoch (not beyond) and backfill again, until
    // no further epoch gaps. Preserves forward secrecy (epoch-N keys consumed only after all epoch-N
    // messages decrypt). Shared by the on-subscribe catch-up and the transport-gap backfill.
    //
    // Track 4 slice 5b — the drain can fail to advance because the commit that would close the gap was
    // PRUNED (or we were offline beyond retention). Before 5b that spun forever (backfill keeps returning
    // the same future-epoch message; the drain keeps no-op'ing). Now a non-advancing drain is classified:
    // a genuine gap escalates to onSyncLost and stops; a transient stall retries within a bounded budget.
    const runCatchUp = (conversationId: string): void => {
      const group = liveGroups.current.get(conversationId);
      if (!group) return;
      void (async () => {
        let transientStalls = 0;
        for (;;) {
          const result = await backfillInto(conversationId, group, selfUserId);
          const nextEpoch = result?.nextEpoch;
          if (nextEpoch === undefined) break; // no epoch gap — caught up
          const drain = await processCommitEvent(
            deps,
            conversationId,
            group,
            { epoch: nextEpoch },
            nextEpoch,
          );
          if (drain.advanced) {
            transientStalls = 0; // made progress — re-backfill at the new epoch
            continue;
          }
          // The drain couldn't advance the group toward the message's epoch.
          const state = classifyCommitDrain({
            localEpoch: group.epoch,
            targetEpoch: nextEpoch,
            oldestRetainedEpoch: drain.oldestRetainedEpoch,
          });
          if (state === 'sync-lost') {
            // eslint-disable-next-line no-console
            console.warn('catch-up: conversation sync-lost (commit pruned)', conversationId);
            signalSyncLost(conversationId);
            break;
          }
          transientStalls += 1;
          if (transientStalls >= CATCHUP_MAX_TRANSIENT_STALLS) break; // self-heals via next event/reconnect
          await sleep(CATCHUP_RETRY_DELAY_MS);
        }
      })().catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('catch-up failed', conversationId, err instanceof Error ? err.message : err);
      });
    };

    // Debounced backfill on a detected transport gap. Coalesces a burst per conversation
    // (GAP_BACKFILL_DEBOUNCE_MS) into one catch-up so a flaky link can't trigger a backfill storm. The
    // catch-up recovers the missed EARLIER frame(s); the live frame that exposed the gap is decrypted inline
    // (onMessage) and never discarded.
    const scheduleGapBackfill = (conversationId: string): void => {
      const timers = gapBackfillTimers.current;
      if (timers.has(conversationId)) return; // a catch-up is already scheduled — coalesce onto it
      const timer = setTimeout(() => {
        timers.delete(conversationId);
        runCatchUp(conversationId);
      }, GAP_BACKFILL_DEBOUNCE_MS);
      timers.set(conversationId, timer);
    };

    const socket = createMessageSocket({
      token: accessToken,
      onStatus: setConnectionStatus,
      // On every (re)connect, poll for enrollment requests that arrived while offline — the WS
      // push only fires while connected, so D1 would miss pending approvals across disconnects.
      onReady: () => {
        void listEnrollments('pending')
          .then((rows) => {
            for (const row of rows) {
              // Mirror the WS event handler: skip enrollments requested by THIS device (D2 should
              // not see its own pending enrollment as a D1 approval prompt).
              if (row.requestingDeviceId === deviceId) continue;
              onEnrollmentPending?.(row.id);
            }
          })
          .catch(() => {
            /* best-effort — missed enrollments reappear on the next reconnect */
          });
        // Retry fan-out for approved enrollments whose fan-out may have been partial (D1 side).
        // enrollDevice is idempotent: it skips conversations where D2 is already a leaf.
        if (messagingDeps) {
          void Promise.all([listEnrollments('approved'), listMyConversations()])
            .then(([approved, conversationIds]) => {
              for (const row of approved) {
                void enrollDevice(
                  messagingDeps,
                  selfUserId,
                  row.requestingDeviceId,
                  row.fingerprint,
                  conversationIds,
                  liveGroups.current,
                ).catch(() => {
                  /* best-effort retry */
                });
              }
            })
            .catch(() => {});
        }
        // D2 side: drain any Welcomes that arrived while offline. The onEnrollmentApproved /
        // onWelcome nudges are only delivered while connected, so a reconnect must re-poll.
        // drainWelcomes is idempotent — it skips already-joined conversations.
        drainRef.current();
      },
      onMessage: ({ conversationId, message, deliverySeq, deliveryPrevSeq }) => {
        // Transport gap detection (Track 3 item D): a break in the per-(socket, conversation) counter means
        // a live frame was dropped/reordered, so re-fetch over the existing backfill. classifyDeliveryFrame
        // owns the decision (pure + unit-tested); the seq is a HINT only, never gating decryption/ordering.
        const { last: nextLast, gap } = classifyDeliveryFrame(
          lastDeliverySeq.current.get(conversationId),
          deliverySeq,
          deliveryPrevSeq,
        );
        if (nextLast !== undefined) lastDeliverySeq.current.set(conversationId, nextLast);
        // On a detected gap, schedule a backfill to recover the missed EARLIER frame(s). We still decrypt
        // THIS frame inline below — the live WS frame is the reliable copy and is never discarded (the
        // backfill's keyset cursor can skip a late-committing earlier-`created_at` row, so dropping the
        // in-hand frame in favour of a re-fetch could lose it). MLS caches skipped-generation keys, so the
        // backfill can still decrypt the earlier frame out of order; a same-sender burst exceeding that
        // bounded cache (`retainKeysForGenerations`) before the backfill runs is an accepted
        // delivery-completeness residual, backstopped by the reconnect connect-protocol (realtime-delivery.md §6).
        if (gap) scheduleGapBackfill(conversationId);

        const group = liveGroups.current.get(conversationId);
        if (!group) return;
        void (async () => {
          // If the message was encrypted at a newer epoch, drain commits to EXACTLY that epoch
          // before decrypting. Passing maxEpoch = message.epoch prevents the drain from overshooting
          // and consuming keys that belong to messages still in-flight at intermediate epochs.
          if (message.epoch > group.epoch) {
            const drain = await processCommitEvent(
              deps,
              conversationId,
              group,
              { epoch: message.epoch },
              message.epoch,
            );
            // Track 4 slice 5b — if the drain couldn't reach the live message's epoch because the
            // commit that would advance the group was pruned, this conversation is sync-lost. Without
            // this check a freshly-subscribed device with no backlog (so runCatchUp found no gap) would
            // silently log the message as undecryptable below and only recover on an unrelated
            // reconnect. A transient stall falls through and self-heals via the catch-up/gap paths.
            if (group.epoch < message.epoch) {
              const state = classifyCommitDrain({
                localEpoch: group.epoch,
                targetEpoch: message.epoch,
                oldestRetainedEpoch: drain.oldestRetainedEpoch,
              });
              if (state === 'sync-lost') {
                // eslint-disable-next-line no-console
                console.warn('ws message: conversation sync-lost (commit pruned)', conversationId);
                signalSyncLost(conversationId);
                return; // unreachable epoch — don't attempt an undecryptable read
              }
            }
          }
          const decrypted = await receiveLiveMessage(
            deps,
            conversationId,
            group,
            message,
            selfUserId,
          );
          if (decrypted) mergeIncoming(conversationId, [decrypted]);
        })().catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.warn(
            'ws receive failed',
            conversationId,
            err instanceof Error ? err.message : err,
          );
        });
      },
      onReceipt: applyReceipt,
      onSubscribed: (conversationId) => {
        // A fresh room join (re)starts the gateway's per-socket counter, so drop any stale baseline — the
        // first live frame (deliveryPrevSeq === null) re-establishes it. Also cancel any pending gap timer:
        // the REST catch-up below already covers anything missed up to now.
        lastDeliverySeq.current.delete(conversationId);
        const pendingTimer = gapBackfillTimers.current.get(conversationId);
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          gapBackfillTimers.current.delete(conversationId);
        }
        runCatchUp(conversationId);
        seedReceipts(conversationId); // seed historical delivered/read ticks once in the room
      },
      // A Welcome is waiting (added to a conversation while connected): drain now — join → subscribe →
      // backfill ride the existing onJoined → addLive path, so the conversation + its messages appear live.
      onWelcome: () => drainRef.current(),
      onRemoved: (conversationId) => {
        liveGroups.current.delete(conversationId);
        lastDeliverySeq.current.delete(conversationId);
        const pending = gapBackfillTimers.current.get(conversationId);
        if (pending) {
          clearTimeout(pending);
          gapBackfillTimers.current.delete(conversationId);
        }
        setLiveIds((prev) => {
          if (!prev.has(conversationId)) return prev;
          const next = new Set(prev);
          next.delete(conversationId);
          return next;
        });
        setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      },
      // B2: another device of this user registered a pending enrollment — D1 should show approval UI.
      // Filter: skip the event on the requesting device itself (D2 should not see its own enrollment prompt).
      onEnrollmentPending: (enrollmentId, requestingDeviceId) => {
        if (requestingDeviceId === deviceId) return;
        onEnrollmentPending?.(enrollmentId);
      },
      // B2: an enrollment for this user was approved. The gateway fans this account-level event to all
      // connected devices, so only the requesting device may clear its local provisional flag or drain.
      onEnrollmentApproved: (enrollmentId) => {
        void listEnrollments('approved')
          .then((rows) => {
            const enrollment = rows.find((row) => row.id === enrollmentId);
            if (enrollment?.requestingDeviceId !== deviceId) return;
            onEnrollmentApproved?.(enrollmentId);
            drainRef.current();
          })
          .catch(() => {
            /* best-effort — the next reconnect/poll rechecks approved enrollments */
          });
      },
      onFriendRequest: () => {
        onFriendRequest?.();
      },
      // A membership commit was posted: drain to exactly this commit (epoch+1 ceiling) so the group
      // advances to epoch+1 but no further. An unbounded drain would consume forward-secret keys for
      // messages still in-flight at epoch+1, making them permanently undecryptable on arrival.
      //
      // Track 4 slice 5b — if the drain can't advance and the needed commit was pruned, escalate to
      // sync-lost (recovery wired in 5c). A transient stall just returns; the next event/reconnect retries.
      onCommit: ({ conversationId, epoch }) => {
        const group = liveGroups.current.get(conversationId);
        if (!group) return;
        void (async () => {
          const drain = await processCommitEvent(deps, conversationId, group, { epoch }, epoch + 1);
          if (drain.advanced || drain.stoppedReason === 'stale') return; // progress, or already past
          const state = classifyCommitDrain({
            localEpoch: group.epoch,
            targetEpoch: epoch + 1,
            oldestRetainedEpoch: drain.oldestRetainedEpoch,
          });
          if (state === 'sync-lost') {
            // eslint-disable-next-line no-console
            console.warn('commit drain: conversation sync-lost (commit pruned)', conversationId);
            signalSyncLost(conversationId);
          }
        })().catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.warn(
            'commit drain failed',
            conversationId,
            err instanceof Error ? err.message : err,
          );
        });
      },
    });
    socketRef.current = socket;
    for (const id of liveGroups.current.keys()) socket.subscribe(id);
    return () => {
      socket.close();
      socketRef.current = null;
      // Cancel any pending gap backfills; this socket (and its per-socket counters) is gone.
      for (const timer of gapBackfillTimers.current.values()) clearTimeout(timer);
      gapBackfillTimers.current.clear();
      lastDeliverySeq.current.clear();
    };
  }, [
    applyReceipt,
    backfillInto,
    deviceId,
    mergeIncoming,
    messagingDeps,
    onEnrollmentApproved,
    onEnrollmentPending,
    onFriendRequest,
    onSyncLost,
    seedReceipts,
    selfUserId,
  ]);

  return { liveIds, liveGroups, addLive, connectionStatus, refoldPeerReceiptWatermarks };
}
