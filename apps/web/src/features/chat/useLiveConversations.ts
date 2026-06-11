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
import { fetchReceipts } from '../../lib/api';
import { joinPendingConversations } from '../../lib/join';
import { receiveLiveMessage, type DecryptedMessage, type MessagingDeps } from '../../lib/messaging';
import {
  createMessageSocket,
  type IncomingReceipt,
  type MessageSocket,
  type MessageSocketStatus,
} from '../../lib/ws';
import { isReadReceiptsEnabled } from '../settings/privacy-settings';
import { placeholderPeerId, resolvePeerUser, withPeerNamed } from './peer-naming';
import { foldOwnMessageStatuses, type PeerWatermarks } from './receipts';
import type { Conversation, User } from './seed';
import { currentUser, generatedAvatar } from './seed';

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
  ) => void | Promise<void>;
  setConversations: Dispatch<SetStateAction<Conversation[]>>;
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
      passphrase: messagingDeps.passphrase,
      sessionKey: messagingDeps.sessionKey,
      // A one-time private was just spent: drop it from the SESSION pool so a later live nudge's drain can't
      // resurrect it (the keystore prune doesn't touch this in-memory pool). `member` is a reference from
      // sessionPool, so identity-match is exact.
      onSpent: (member) => {
        const at = sessionPool.indexOf(member);
        if (at !== -1) sessionPool.splice(at, 1);
      },
      onJoined: ({ conversationId, conversation, senderUserId }) => {
        addLive(conversationId, conversation);
        const shell = liveConversationShell(conversationId, currentUserProfile);
        setConversations((prev) => prependConversationIfMissing(prev, shell));
        // Name the new conversation after the (verified) member who added us — best-effort, async; the
        // placeholder stays if the directory lookup misses.
        void resolvePeerUser(senderUserId).then((peer) => {
          if (peer) setConversations((prev) => withPeerNamed(prev, conversationId, peer));
        });
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
  }, [addLive, currentUserProfile, device, deviceId, messagingDeps, pool, setConversations]);

  useEffect(() => {
    drainRef.current = drainWelcomes;
  }, [drainWelcomes]);

  // Join on connect: the initial drain once the device is unlocked and provisioned.
  useEffect(() => {
    if (!device || !pool || !deviceId || !messagingDeps || joinRanRef.current) return;
    joinRanRef.current = true;
    drainWelcomes();
  }, [device, deviceId, drainWelcomes, messagingDeps, pool]);

  // Realtime push (Slice 5C): one reconnecting WebSocket authenticated in the first frame.
  useEffect(() => {
    if (!messagingDeps || !selfUserId) {
      setConnectionStatus('offline');
      return;
    }
    setConnectionStatus('connecting');
    const deps = messagingDeps;
    const socket = createMessageSocket({
      token: accessToken,
      onStatus: setConnectionStatus,
      onMessage: ({ conversationId, message }) => {
        const group = liveGroups.current.get(conversationId);
        if (!group) return;
        void receiveLiveMessage(deps, conversationId, group, message, selfUserId)
          .then((decrypted) => {
            if (decrypted) mergeIncoming(conversationId, [decrypted]);
          })
          .catch((err: unknown) => {
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
        const group = liveGroups.current.get(conversationId);
        if (group) void backfillInto(conversationId, group, selfUserId);
        seedReceipts(conversationId); // seed historical delivered/read ticks once in the room
      },
      // A Welcome is waiting (added to a conversation while connected): drain now — join → subscribe →
      // backfill ride the existing onJoined → addLive path, so the conversation + its messages appear live.
      onWelcome: () => drainRef.current(),
    });
    socketRef.current = socket;
    for (const id of liveGroups.current.keys()) socket.subscribe(id);
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [applyReceipt, backfillInto, mergeIncoming, messagingDeps, seedReceipts, selfUserId]);

  return { liveIds, liveGroups, addLive, connectionStatus };
}
