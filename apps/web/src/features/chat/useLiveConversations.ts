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
}

interface UseLiveConversationsResult {
  liveIds: Set<string>;
  liveGroups: { current: Map<string, MlsGroup> };
  addLive: (conversationId: string, conversation: MlsGroup) => void;
  connectionStatus: MessageSocketStatus;
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
  onPeerKeyChanged,
  onPeerVerified,
  onSafetyNumberResolved,
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
  // conversation) `deliverySeq` we saw; a non-contiguous next frame means a live frame was dropped/reordered,
  // so we re-fetch over the existing backfill. gapBackfillTimers coalesces a burst of gaps per conversation
  // into one fetch. `catchUpDepth` counts a conversation's outstanding catch-up obligations (scheduled-but-
  // not-fired timers + in-flight catch-ups); while > 0 we DEFER inline live decryption (see onMessage) so the
  // backfill decrypts from the durable cursor in generation ORDER and never consumes a later generation before
  // the missed earlier one (MLS's skipped-key cache is bounded — `retainKeysForGenerations`, 10 by default —
  // so a burst could otherwise evict it and lose the message). A counter, not a flag, so a gap seen while an
  // earlier catch-up is still running keeps the deferral active until every queued pass settles. All reset on
  // (re)subscribe and on removal. The seq is a HINT only — it never gates decryption or ordering (MLS + the
  // (created_at,id) cursor own those); it carries no cryptographic guarantee.
  const lastDeliverySeq = useRef(new Map<string, number>());
  const gapBackfillTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const catchUpDepth = useRef(new Map<string, number>());

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

    // Interleaved catch-up for one conversation: backfill at the current epoch, then — if messages at a
    // future epoch were seen — drain commits to EXACTLY that epoch (not beyond) and backfill again, until
    // no further epoch gaps. Preserves forward secrecy (epoch-N keys consumed only after all epoch-N
    // messages decrypt). Shared by the on-subscribe catch-up and the transport-gap backfill.
    const runCatchUp = (conversationId: string): Promise<void> => {
      const group = liveGroups.current.get(conversationId);
      if (!group) return Promise.resolve();
      return (async () => {
        for (;;) {
          const result = await backfillInto(conversationId, group, selfUserId);
          const nextEpoch = result?.nextEpoch;
          if (nextEpoch === undefined) break;
          await processCommitEvent(deps, conversationId, group, { epoch: nextEpoch }, nextEpoch);
        }
      })().catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('catch-up failed', conversationId, err instanceof Error ? err.message : err);
      });
    };

    // Debounced backfill on a detected transport gap. Raises the conversation's catch-up obligation count
    // immediately (so onMessage stops decrypting its live frames inline — see there) and coalesces a burst
    // per conversation (GAP_BACKFILL_DEBOUNCE_MS) into one fetch. The catch-up re-decrypts from the durable
    // cursor in generation order. Live decryption resumes only when EVERY scheduled/in-flight catch-up for
    // the conversation has settled — a gap observed *while* an earlier catch-up is still fetching raises the
    // count again, so the deferral can't be cleared out from under a still-pending pass.
    const scheduleGapBackfill = (conversationId: string): void => {
      const timers = gapBackfillTimers.current;
      if (timers.has(conversationId)) return; // a catch-up is already scheduled — coalesce onto it
      const depth = catchUpDepth.current;
      depth.set(conversationId, (depth.get(conversationId) ?? 0) + 1); // a new catch-up obligation
      const timer = setTimeout(() => {
        timers.delete(conversationId);
        void runCatchUp(conversationId).finally(() => {
          const remaining = (depth.get(conversationId) ?? 0) - 1;
          if (remaining > 0) depth.set(conversationId, remaining);
          else depth.delete(conversationId); // last obligation done → live decryption resumes
        });
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
        if (gap) scheduleGapBackfill(conversationId);
        // While catching up after a gap, DON'T decrypt this frame inline — the pending backfill re-decrypts
        // from the durable cursor in generation order, so we never advance/consume the receive ratchet past
        // the missed earlier message (whose skipped key MLS only caches for a bounded window). The frame is
        // durably stored, so the backfill picks it up and dedup-by-id avoids a double-render.
        if ((catchUpDepth.current.get(conversationId) ?? 0) > 0) return;

        const group = liveGroups.current.get(conversationId);
        if (!group) return;
        void (async () => {
          // If the message was encrypted at a newer epoch, drain commits to EXACTLY that epoch
          // before decrypting. Passing maxEpoch = message.epoch prevents the drain from overshooting
          // and consuming keys that belong to messages still in-flight at intermediate epochs.
          if (message.epoch > group.epoch) {
            await processCommitEvent(
              deps,
              conversationId,
              group,
              { epoch: message.epoch },
              message.epoch,
            );
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
        // first live frame (deliveryPrevSeq === null) re-establishes it. Also cancel any pending gap timer
        // and clear the catch-up gate: the REST catch-up below already covers anything missed up to now.
        lastDeliverySeq.current.delete(conversationId);
        const pendingTimer = gapBackfillTimers.current.get(conversationId);
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          gapBackfillTimers.current.delete(conversationId);
        }
        catchUpDepth.current.delete(conversationId);
        runCatchUp(conversationId);
        seedReceipts(conversationId); // seed historical delivered/read ticks once in the room
      },
      // A Welcome is waiting (added to a conversation while connected): drain now — join → subscribe →
      // backfill ride the existing onJoined → addLive path, so the conversation + its messages appear live.
      onWelcome: () => drainRef.current(),
      onRemoved: (conversationId) => {
        liveGroups.current.delete(conversationId);
        lastDeliverySeq.current.delete(conversationId);
        catchUpDepth.current.delete(conversationId);
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
      // B2: this user's enrollment was approved — D2 drains Welcomes to join conversations D1 added it to.
      onEnrollmentApproved: () => {
        drainRef.current();
      },
      // A membership commit was posted: drain to exactly this commit (epoch+1 ceiling) so the group
      // advances to epoch+1 but no further. An unbounded drain would consume forward-secret keys for
      // messages still in-flight at epoch+1, making them permanently undecryptable on arrival.
      onCommit: ({ conversationId, epoch }) => {
        const group = liveGroups.current.get(conversationId);
        if (!group) return;
        void processCommitEvent(deps, conversationId, group, { epoch }, epoch + 1).catch(
          (err: unknown) => {
            // eslint-disable-next-line no-console
            console.warn(
              'commit drain failed',
              conversationId,
              err instanceof Error ? err.message : err,
            );
          },
        );
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
      catchUpDepth.current.clear();
    };
  }, [
    applyReceipt,
    backfillInto,
    mergeIncoming,
    messagingDeps,
    onEnrollmentPending,
    seedReceipts,
    selfUserId,
  ]);

  return { liveIds, liveGroups, addLive, connectionStatus };
}
