import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Conversation as MlsGroup } from '@argus/crypto';
import type { StoredMessage } from '../../lib/keystore';
import type { AttachmentRef } from '../../lib/message-envelope';
import { getConversationMembers, listCommits, listMyConversationsWithMeta } from '../../lib/api';
import {
  backfillConversation,
  type DecryptedMessage,
  type MessagingDeps,
} from '../../lib/messaging';
import { loadPersistedPeerMapping, resolvePeerUser, withPeerNamed } from './peer-naming';
import { dicebearAvatar } from '../../lib/dicebear';
import { liveConversationShell, replaceOrPrependConversation } from './useLiveConversations';
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
  ) => Promise<{ nextEpoch: number | undefined }> | void;
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
  backfillInto: (
    conversationId: string,
    group: MlsGroup,
    selfUserId: string,
  ) => Promise<{ nextEpoch: number | undefined }>;
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
        void resolvePeerUser(peerSender, conversationId).then((peer) => {
          if (peer) setConversations((prev) => withPeerNamed(prev, conversationId, peer));
        });
      }
    },
    [appendHistory, setConversations],
  );

  const backfillInto = useCallback(
    async (
      conversationId: string,
      group: MlsGroup,
      selfUserId: string,
    ): Promise<{ nextEpoch: number | undefined }> => {
      if (!messagingDeps) return { nextEpoch: undefined };
      if (backfilling.current.has(conversationId)) {
        backfillPending.current.add(conversationId);
        return { nextEpoch: undefined };
      }
      backfilling.current.add(conversationId);
      let lastNextEpoch: number | undefined;
      try {
        do {
          backfillPending.current.delete(conversationId);
          const after = fetchCursors.current.get(conversationId);
          const { messages, cursor, nextEpoch } = await backfillConversation(
            messagingDeps,
            conversationId,
            group,
            selfUserId,
            after,
          );
          lastNextEpoch = nextEpoch;
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
      return { nextEpoch: lastNextEpoch };
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
    const { keystore, device } = messagingDeps;
    const sKey = sessionKey;
    void (async () => {
      try {
        const restored = await keystore.loadConversations(
          device,
          sKey,
          async (conversationId, epoch, clientCommitId) => {
            // Verify OUR commit (identified by clientCommitId) won the epoch slot — not another
            // member's. Epoch-only checks are insufficient: if two clients staged at the same epoch
            // and ours lost the race (409), another commit exists at that epoch but our post-commit
            // state would be on a divergent ratchet branch.
            const commits = await listCommits(conversationId, { afterEpoch: epoch - 1, limit: 1 });
            return commits.some((c) => c.epoch === epoch && c.clientCommitId === clientCommitId);
          },
        );
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
            replaceOrPrependConversation(prev, {
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
              const peer = await resolvePeerUser(senderId, conversationId);
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

/**
 * Pure helper: given the server roster and per-conversation member lists, return the ordered
 * set of placeholder Conversation objects for the recovery UI. Exported for unit testing.
 */
export function buildRosterPlaceholders(
  conversations: Array<{ id: string; isDirect: boolean | null; createdAt: string }>,
  membersMap: Map<string, Array<{ userId: string; argusId: string; displayName: string | null }>>,
  selfUserId: string,
  selfProfile: User,
): Conversation[] {
  const directConvs = conversations
    .filter((c) => c.isDirect === true)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const seenPeers = new Set<string>();
  const result: Conversation[] = [];
  for (const conv of directConvs) {
    const convMembers = membersMap.get(conv.id) ?? [];
    const nonSelfMembers = convMembers.filter((m) => m.userId !== selfUserId);
    // Require exactly one peer — isDirect=true rows that gained extra members after creation
    // (via add-member commits) would otherwise render as a 1:1 placeholder with a random peer.
    if (nonSelfMembers.length !== 1) continue;
    const peer = nonSelfMembers[0]!;
    if (seenPeers.has(peer.userId)) continue;
    seenPeers.add(peer.userId);
    result.push({
      id: conv.id,
      type: 'direct',
      recoveredFromServer: true,
      participants: [
        selfProfile,
        {
          id: peer.userId,
          name: peer.displayName?.trim() || peer.argusId,
          avatar: dicebearAvatar(peer.userId),
        },
      ],
      messages: [],
      unreadCount: 0,
    });
  }
  return result;
}

/**
 * From a fresh roster-recovery batch, return only the placeholders that are not already
 * represented in `conversations` — either by conversation id or by peer user id. Exported
 * for unit testing.
 */
export function filterNewPlaceholders(
  conversations: Conversation[],
  placeholders: Conversation[],
): Conversation[] {
  const existingIds = new Set(conversations.map((c) => c.id));
  // Exclude placeholders whose peer is already in an existing direct conversation
  // (covers the case where the keystore has conv-A with User B and the server roster
  // returns a newer conv-B — also with User B — created by tap-to-resume).
  const existingPeerIds = new Set(
    conversations
      .filter((c) => c.type === 'direct' && c.participants.length >= 2)
      .map((c) => c.participants[1]!.id),
  );
  return placeholders.filter(
    (p) => !existingIds.has(p.id) && !existingPeerIds.has(p.participants[1]!.id),
  );
}

interface RosterRecoveryOptions {
  messagingDeps: MessagingDeps | null;
  sessionKey: CryptoKey | null;
  currentUserProfile: User;
  selfUserId: string | undefined;
  setConversations: Dispatch<SetStateAction<Conversation[]>>;
}

/**
 * Recover the direct-conversation roster from the server after a PWA reinstall.
 *
 * Runs once after device unlock. Fetches all conversations the caller is a member of, filters
 * to confirmed direct (is_direct = true) rows, deduplicates by peer userId keeping the most
 * recently-created conversation, then prepends read-only placeholder entries for contacts whose
 * conversation is not already present in local state (no MLS group in keystore).
 *
 * Placeholders are not added to liveIds — selectedIsLive remains false for them, so the existing
 * ChatInput disabled path prevents sending until tap-to-resume (PR 4) creates a fresh MLS group.
 */
export function useRosterRecovery({
  messagingDeps,
  sessionKey,
  currentUserProfile,
  selfUserId,
  setConversations,
}: RosterRecoveryOptions): void {
  const recoveredRef = useRef(false);

  useEffect(() => {
    if (!messagingDeps || !sessionKey || !selfUserId || recoveredRef.current) return;
    recoveredRef.current = true;

    void (async () => {
      try {
        const allConvs = await listMyConversationsWithMeta();
        // Fetch members for each potentially-direct conversation.
        const membersMap = new Map<
          string,
          Array<{ userId: string; argusId: string; displayName: string | null }>
        >();
        for (const conv of allConvs.filter((c) => c.isDirect === true)) {
          membersMap.set(conv.id, await getConversationMembers(conv.id));
        }
        const placeholders = buildRosterPlaceholders(
          allConvs,
          membersMap,
          selfUserId,
          currentUserProfile,
        );
        // Batch-prepend to preserve the newest-first order from buildRosterPlaceholders.
        // Per-item prepends would reverse the batch because each prepend inserts at the front.
        setConversations((prev) => {
          const toAdd = filterNewPlaceholders(prev, placeholders);
          return toAdd.length > 0 ? [...toAdd, ...prev] : prev;
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('roster recovery failed', err instanceof Error ? err.message : err);
      }
    })();
  }, [messagingDeps, sessionKey, selfUserId, currentUserProfile, setConversations]);
}
