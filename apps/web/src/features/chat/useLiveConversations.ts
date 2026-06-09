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
        id: `peer-${conversationId}`,
        name: 'New contact',
        avatar: generatedAvatar(conversationId),
        isOnline: false,
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

  const addLive = useCallback((conversationId: string, conversation: MlsGroup): void => {
    liveGroups.current.set(conversationId, conversation);
    setLiveIds((prev) => addLiveId(prev, conversationId));
    socketRef.current?.subscribe(conversationId);
  }, []);

  // Join on connect (Slice 4 + 5B): drain pending Welcomes once the device is unlocked and provisioned.
  useEffect(() => {
    if (!device || !pool || !deviceId || !messagingDeps || joinRanRef.current) return;
    joinRanRef.current = true;
    joinPendingConversations({
      device,
      pool,
      deviceId,
      keystore: messagingDeps.keystore,
      passphrase: messagingDeps.passphrase,
      onJoined: ({ conversationId, conversation }) => {
        addLive(conversationId, conversation);
        const shell = liveConversationShell(conversationId, currentUserProfile);
        setConversations((prev) => prependConversationIfMissing(prev, shell));
      },
    }).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('join-on-connect drain failed', err instanceof Error ? err.message : err);
    });
  }, [addLive, currentUserProfile, device, deviceId, messagingDeps, pool, setConversations]);

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
