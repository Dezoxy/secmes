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
import { joinPendingConversations } from '../../lib/join';
import { receiveLiveMessage, type DecryptedMessage, type MessagingDeps } from '../../lib/messaging';
import { createMessageSocket, type MessageSocket, type MessageSocketStatus } from '../../lib/ws';
import { placeholderPeerId, resolvePeerUser, withPeerNamed } from './peer-naming';
import type { Conversation, User } from './seed';
import { generatedAvatar } from './seed';

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
  // Latest drain in a ref so the long-lived socket can call it without being torn down on re-renders.
  const drainRef = useRef<() => void>(() => {});

  const addLive = useCallback((conversationId: string, conversation: MlsGroup): void => {
    liveGroups.current.set(conversationId, conversation);
    setLiveIds((prev) => addLiveId(prev, conversationId));
    socketRef.current?.subscribe(conversationId);
  }, []);

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
    drainState.running = true;
    joinPendingConversations({
      device,
      pool,
      deviceId,
      keystore: messagingDeps.keystore,
      passphrase: messagingDeps.passphrase,
      sessionKey: messagingDeps.sessionKey,
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
      onSubscribed: (conversationId) => {
        const group = liveGroups.current.get(conversationId);
        if (group) void backfillInto(conversationId, group, selfUserId);
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
  }, [backfillInto, mergeIncoming, messagingDeps, selfUserId]);

  return { liveIds, liveGroups, addLive, connectionStatus };
}
