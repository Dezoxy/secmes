import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Conversation as MlsGroup } from '@argus/crypto';
import type { StoredMessage } from '../../lib/keystore';
import type { AttachmentRef } from '../../lib/message-envelope';
import {
  backfillConversation,
  type DecryptedMessage,
  type MessagingDeps,
} from '../../lib/messaging';
import { loadPersistedPeerMapping, resolvePeerUser, withPeerNamed } from './peer-naming';
import { liveConversationShell, prependConversationIfMissing } from './useLiveConversations';
import type { Attachment, Conversation, Message, User } from './seed';

interface ConversationBackfillOptions {
  messagingDeps: MessagingDeps | null;
  sessionKey: CryptoKey | null;
  setConversations: Dispatch<SetStateAction<Conversation[]>>;
}

interface SelectedBackfillOptions {
  selectedId: string | null;
  selectedIsLive: boolean;
  selfUserId: string | undefined;
  liveGroups: { current: Map<string, MlsGroup> };
  backfillInto: (
    conversationId: string,
    group: MlsGroup,
    selfUserId: string,
  ) => void | Promise<void>;
}

interface HistoryRehydrationOptions {
  messagingDeps: MessagingDeps | null;
  sessionKey: CryptoKey | null;
  currentUserProfile: User;
  /** The signed-in user's SERVER id — excludes own history entries when deriving the peer for naming. */
  selfUserId: string | undefined;
  addLive: (conversationId: string, conversation: MlsGroup) => void;
  setConversations: Dispatch<SetStateAction<Conversation[]>>;
}

interface ConversationBackfillResult {
  appendHistory: (conversationId: string, entries: StoredMessage[]) => void;
  mergeIncoming: (conversationId: string, incoming: DecryptedMessage[]) => void;
  backfillInto: (conversationId: string, group: MlsGroup, selfUserId: string) => Promise<void>;
}

// A live (E2E) attachment ref -> a UI attachment. Images download+decrypt lazily from `ref` (no URL).
export function refToUiAttachment(ref: AttachmentRef): Attachment {
  return {
    id: `att-${ref.objectKey}`,
    type: ref.mime.startsWith('image/') ? 'image' : 'file',
    name: ref.name,
    size: `${(ref.size / 1024 / 1024).toFixed(1)} MB`,
    ref,
  };
}

// Map a persisted history entry back to a UI Message. Plaintext stays local.
export function storedToMessage(message: StoredMessage): Message {
  return {
    id: message.id,
    senderId: message.senderId,
    content: message.content,
    timestamp: new Date(message.timestamp),
    status: message.status as Message['status'],
    encrypted: message.encrypted,
    attachments: message.attachments?.map(refToUiAttachment),
  };
}

export function decryptedToMessage(message: DecryptedMessage): Message {
  return {
    id: message.serverId,
    senderId: message.senderUserId ?? '', // null = GDPR-erased sender; '' never matches a real user id
    content: message.text,
    timestamp: new Date(message.createdAt),
    status: 'read',
    encrypted: true,
    attachments: message.attachments.length
      ? message.attachments.map(refToUiAttachment)
      : undefined,
  };
}

export function decryptedToStoredMessage(message: DecryptedMessage): StoredMessage {
  return {
    id: message.serverId,
    senderId: message.senderUserId ?? '', // null = GDPR-erased sender
    content: message.text,
    timestamp: message.createdAt,
    status: 'read',
    encrypted: true,
    kind: message.kind,
    attachments: message.attachments.length ? message.attachments : undefined,
  };
}

export function mergeIncomingMessages(
  conversations: Conversation[],
  conversationId: string,
  incoming: DecryptedMessage[],
): Conversation[] {
  if (incoming.length === 0) return conversations;

  // group-meta messages carry the group name (not shown as chat bubbles); app messages go to the
  // transcript. Latest group-meta text wins (they arrive in epoch order, so the last one is newest).
  const appMessages = incoming.filter((m) => m.kind !== 'group-meta');
  const latestGroupName = incoming
    .filter((m) => m.kind === 'group-meta' && m.text.trim())
    .at(-1)
    ?.text.trim();

  return conversations.map((conversation) => {
    if (conversation.id !== conversationId) return conversation;
    const existing = new Set(conversation.messages.map((message) => message.id));
    const fresh = appMessages.filter((message) => !existing.has(message.serverId));
    const base: Conversation = latestGroupName
      ? { ...conversation, name: latestGroupName, type: 'group' }
      : conversation;
    if (fresh.length === 0) return base;

    return {
      ...base,
      messages: [...base.messages, ...fresh.map(decryptedToMessage)].sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
      ),
    };
  });
}

export function useConversationBackfill({
  messagingDeps,
  sessionKey,
  setConversations,
}: ConversationBackfillOptions): ConversationBackfillResult {
  const fetchCursors = useRef(new Map<string, string>());
  const backfilling = useRef(new Set<string>());
  const backfillPending = useRef(new Set<string>());
  // Conversations whose peer naming has been attempted this session (gate, not a guarantee — withPeerNamed
  // itself no-ops when the conversation was already named by the join/creator path).
  const peerNamingTried = useRef(new Set<string>());

  // Persist messages to the local SEALED history log. Plaintext in -> sealed at rest under the session key.
  const appendHistory = useCallback(
    (conversationId: string, entries: StoredMessage[]): void => {
      if (!messagingDeps || !sessionKey || entries.length === 0) return;
      void messagingDeps.keystore
        .appendMessages(messagingDeps.device, conversationId, sessionKey, entries)
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.warn(
            'persist history failed',
            conversationId,
            err instanceof Error ? err.message : err,
          );
        });
    },
    [messagingDeps, sessionKey],
  );

  const mergeIncoming = useCallback(
    (conversationId: string, incoming: DecryptedMessage[]): void => {
      if (incoming.length === 0) return;
      setConversations((prev) => mergeIncomingMessages(prev, conversationId, incoming));
      // Persist all messages including group-meta so group name survives page reload.
      appendHistory(conversationId, incoming.map(decryptedToStoredMessage));
      // Name a still-placeholder peer from the (server-verified) sender of any non-meta message.
      const peerSender = incoming.find((m) => m.kind !== 'group-meta')?.senderUserId;
      if (peerSender && !peerNamingTried.current.has(conversationId)) {
        peerNamingTried.current.add(conversationId);
        void resolvePeerUser(peerSender).then((peer) => {
          if (peer) setConversations((prev) => withPeerNamed(prev, conversationId, peer));
        });
      }
    },
    [appendHistory, setConversations],
  );

  const backfillInto = useCallback(
    async (conversationId: string, group: MlsGroup, selfUserId: string): Promise<void> => {
      if (!messagingDeps) return;
      if (backfilling.current.has(conversationId)) {
        backfillPending.current.add(conversationId);
        return;
      }
      backfilling.current.add(conversationId);
      try {
        do {
          backfillPending.current.delete(conversationId);
          const after = fetchCursors.current.get(conversationId);
          const { messages, cursor } = await backfillConversation(
            messagingDeps,
            conversationId,
            group,
            selfUserId,
            after,
          );
          if (cursor) fetchCursors.current.set(conversationId, cursor);
          mergeIncoming(conversationId, messages);
        } while (backfillPending.current.has(conversationId));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('backfill failed', conversationId, err instanceof Error ? err.message : err);
      } finally {
        backfilling.current.delete(conversationId);
        backfillPending.current.delete(conversationId);
      }
    },
    [messagingDeps, mergeIncoming],
  );

  return { appendHistory, mergeIncoming, backfillInto };
}

export function useSelectedConversationBackfill({
  selectedId,
  selectedIsLive,
  selfUserId,
  liveGroups,
  backfillInto,
}: SelectedBackfillOptions): void {
  useEffect(() => {
    if (!selectedId || !selectedIsLive || !selfUserId) return;
    const group = liveGroups.current.get(selectedId);
    if (!group) return;
    void backfillInto(selectedId, group, selfUserId);
  }, [backfillInto, liveGroups, selectedId, selectedIsLive, selfUserId]);
}

export function useConversationHistoryRehydration({
  messagingDeps,
  sessionKey,
  currentUserProfile,
  selfUserId,
  addLive,
  setConversations,
}: HistoryRehydrationOptions): void {
  const rehydratedRef = useRef(false);

  useEffect(() => {
    if (!messagingDeps || !sessionKey || rehydratedRef.current) return;
    rehydratedRef.current = true;
    const { keystore, device, passphrase } = messagingDeps;
    const sKey = sessionKey;
    void (async () => {
      try {
        const restored = await keystore.loadConversations(device, passphrase, sKey);
        const logs = await keystore.loadAllMessageLogs(device, sKey);
        const creatorIds = await keystore.getGroupCreatorIds(device);
        for (const [conversationId, conversation] of restored) {
          addLive(conversationId, conversation);
          const stored = logs.get(conversationId) ?? [];
          const groupName = stored
            .filter((m) => m.kind === 'group-meta')
            .at(-1)
            ?.content.trim();
          const history = stored.filter((m) => m.kind !== 'group-meta').map(storedToMessage);
          const creatorId = creatorIds.get(conversationId);
          setConversations((prev) =>
            prependConversationIfMissing(prev, {
              ...liveConversationShell(conversationId, currentUserProfile),
              messages: history,
              ...(groupName ? { name: groupName, type: 'group' as const } : {}),
              ...(creatorId ? { creatorId } : {}),
            }),
          );
          // Name the peer: try the persisted mapping first (set at creation — survives a no-reply
          // reload), then fall back to distinct foreign senders from history. Best-effort.
          const persistedPeerId = loadPersistedPeerMapping(conversationId);
          const senderIds = [
            ...(persistedPeerId ? [persistedPeerId] : []),
            ...new Set(stored.map((m) => m.senderId).filter((id) => id && id !== selfUserId)),
          ].slice(0, 3);
          void (async () => {
            for (const senderId of senderIds) {
              const peer = await resolvePeerUser(senderId);
              if (peer) {
                setConversations((prev) => withPeerNamed(prev, conversationId, peer));
                return;
              }
            }
          })();
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('rehydrate conversations failed', err instanceof Error ? err.message : err);
      }
    })();
  }, [addLive, currentUserProfile, messagingDeps, selfUserId, sessionKey, setConversations]);
}
