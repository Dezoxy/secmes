import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { safetyNumberFromMember } from '@argus/crypto';
import type { Conversation as MlsGroup } from '@argus/crypto';
import type { Friend, FriendRequest, MeBound, UserLookupResult } from '../../lib/api';
import type { AnonymousProfile } from '../settings/ProfileSettings';
import {
  fetchPrivacySettings,
  listFriends,
  listFriendRequests,
  listMyConversationsWithMeta,
  sendFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  cancelFriendRequest,
  unfriend,
} from '../../lib/api';
import {
  ConversationManager,
  GroupConversationManager,
  type ConversationSession,
  type GroupConversationSession,
} from '../../lib/conversations';
import type { MessagingDeps } from '../../lib/messaging';
import type { StoredMessage } from '../../lib/keystore';
import type { DecryptedMessage } from '../../lib/messaging';
import type { MessageSocketStatus } from '../../lib/ws';
import { useAuth } from '../auth/AuthContext';
import { demoMode } from '../../lib/auth';
import { useDevice } from '../device/DeviceContext';
import {
  useConversationBackfill,
  useConversationHistoryRehydration,
} from './useConversationBackfill';
import { useLiveConversations } from './useLiveConversations';
import { contactDisplayName } from './user-label';
import { loadArgusProfile, saveArgusProfile } from '../settings/argus-profile';
import { readPrivacySettingsRevision, syncFromServer } from '../settings/privacy-settings';
import { loadPersistedPeerMapping, persistPeerMapping } from './peer-naming';
import { useReceiptSending } from './useReceiptSending';
import { dicebearAvatar, isCustomPhoto } from '../../lib/dicebear';
import {
  initialConversationsForMode,
  currentUser,
  generatedAvatar,
  MAX_AVATAR_DATA_URI_LENGTH,
  safeAvatarSrc,
} from './seed';
import type { Conversation, User } from './seed';

export type { AnonymousProfile } from '../settings/ProfileSettings';

const DEMO_PROFILE_SUBJECT = 'demo-local';
const FRIENDS_REFRESH_RETRY_DELAYS_MS = [300, 900] as const;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function isRetryableFriendRefreshReason(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message === 'Network request failed.' || /status (408|429|5\d\d)\b/.test(message);
}

function shouldRetryFriendRefresh(results: PromiseSettledResult<unknown>[]): boolean {
  const rejected = results.filter((result) => result.status === 'rejected');
  return (
    rejected.length > 0 && rejected.every((result) => isRetryableFriendRefreshReason(result.reason))
  );
}

function currentUserFromProfile(profile: AnonymousProfile): User {
  return {
    ...currentUser,
    name: profile.username,
    avatar: profile.avatar,
    isOnline: true,
  };
}

function withCurrentUserProfile(conversation: Conversation, profile: User): Conversation {
  return {
    ...conversation,
    participants: conversation.participants.map((participant) =>
      participant.id === currentUser.id
        ? { ...participant, name: profile.name, avatar: profile.avatar, isOnline: profile.isOnline }
        : participant,
    ),
  };
}

interface ChatContextValue {
  // Conversations
  conversations: Conversation[];
  setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>;
  // Managers
  manager: ConversationManager | null;
  groupManager: GroupConversationManager | null;
  messagingDeps: MessagingDeps | null;
  // Live connections
  liveIds: ReadonlySet<string>;
  liveGroups: { current: Map<string, MlsGroup> };
  addLive: (conversationId: string, conversation: MlsGroup) => void;
  connectionStatus: MessageSocketStatus;
  // Backfill
  appendHistory: (conversationId: string, entries: StoredMessage[]) => void;
  mergeIncoming: (conversationId: string, incoming: DecryptedMessage[]) => void;
  backfillInto: (
    conversationId: string,
    group: MlsGroup,
    selfUserId: string,
  ) => Promise<{ nextEpoch: number | undefined }>;
  // Friends
  friends: Friend[];
  friendsLoaded: boolean;
  incomingRequests: FriendRequest[];
  outgoingRequests: FriendRequest[];
  friendsError: boolean;
  refreshFriends: () => Promise<void>;
  // Peer maps (DM dedup + friendship gate)
  peerToConvId: Map<string, string>;
  convToPeerId: Map<string, string>;
  peerMapsLoaded: boolean;
  handleSendFriendRequest: (argusId: string) => Promise<void>;
  handleAcceptRequest: (requestId: string) => Promise<void>;
  handleDeclineRequest: (requestId: string) => Promise<void>;
  handleCancelRequest: (requestId: string) => Promise<void>;
  handleUnfriend: (userId: string) => Promise<void>;
  // Profile
  anonymousProfile: AnonymousProfile;
  currentUserProfile: User;
  handleProfileChange: (profile: AnonymousProfile) => boolean;
  serverProfile: MeBound | null | undefined;
  deviceId: string | null;
  // Verification state
  numbersByConv: Record<string, string>;
  setNumbersByConv: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  verifiedByConv: Record<string, string>;
  setVerifiedByConv: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  peerKeyChangedConvId: string | null;
  setPeerKeyChangedConvId: React.Dispatch<React.SetStateAction<string | null>>;
  // Device enrollment
  pendingEnrollmentId: string | null;
  setPendingEnrollmentId: React.Dispatch<React.SetStateAction<string | null>>;
  // Privacy settings
  privacySettingsVersion: number;
  // Conversation creation helpers (shared core logic; screens wrap with local state)
  persistStartedConversation: (session: ConversationSession, peer: UserLookupResult) => void;
  persistGroupCreated: (session: GroupConversationSession) => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChatContext must be used within ChatProvider');
  return ctx;
}

interface ChatProviderProps {
  children: ReactNode;
}

export function ChatProvider({ children }: ChatProviderProps) {
  const [conversations, setConversations] = useState<Conversation[]>(() =>
    initialConversationsForMode(demoMode),
  );
  const [numbersByConv, setNumbersByConv] = useState<Record<string, string>>({});
  const [verifiedByConv, setVerifiedByConv] = useState<Record<string, string>>({});
  const [peerKeyChangedConvId, setPeerKeyChangedConvId] = useState<string | null>(null);
  const [pendingEnrollmentId, setPendingEnrollmentId] = useState<string | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [friendsLoaded, setFriendsLoaded] = useState(false);
  const [incomingRequests, setIncomingRequests] = useState<FriendRequest[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<FriendRequest[]>([]);
  const [friendsError, setFriendsError] = useState(false);
  const refreshFriendsInFlight = useRef<Promise<void> | null>(null);
  const inFlightRequestIds = useRef(new Set<string>());
  const [peerToConvId, setPeerToConvId] = useState<Map<string, string>>(new Map());
  const [convToPeerId, setConvToPeerId] = useState<Map<string, string>>(new Map());
  const [peerMapsLoaded, setPeerMapsLoaded] = useState(false);
  const [privacySettingsVersion, setPrivacySettingsVersion] = useState(0);
  const mappedDMConvsRef = useRef(new Set<string>());

  const { device, pool, deviceId, keystore, sessionKey } = useDevice();
  const { profile, subjectId } = useAuth();
  const profileSubjectId = subjectId ?? DEMO_PROFILE_SUBJECT;

  const [anonymousProfile, setAnonymousProfile] = useState<AnonymousProfile>(() =>
    loadArgusProfile({ subjectId: profileSubjectId }),
  );
  const serverDisplayName = profile?.displayName ?? null;
  const serverUserId = profile?.userId ?? null;

  const currentUserProfile = useMemo(() => {
    const base = currentUserFromProfile(anonymousProfile);
    if (!serverUserId) return base;
    const name = serverDisplayName ?? anonymousProfile.username;
    const hasPhoto = isCustomPhoto(anonymousProfile.avatar, MAX_AVATAR_DATA_URI_LENGTH);
    const avatar = hasPhoto ? anonymousProfile.avatar : dicebearAvatar(serverUserId);
    return { ...base, name, avatar };
  }, [anonymousProfile, serverDisplayName, serverUserId]);

  const messagingDeps = useMemo<MessagingDeps | null>(
    () => (device && keystore && sessionKey ? { device, keystore, sessionKey } : null),
    [device, keystore, sessionKey],
  );

  const manager = useMemo(
    () =>
      messagingDeps && profile?.userId
        ? new ConversationManager(
            messagingDeps.device,
            profile.userId,
            messagingDeps.keystore,
            messagingDeps.sessionKey,
            deviceId ?? null,
          )
        : null,
    [messagingDeps, profile, deviceId],
  );

  const groupManager = useMemo(
    () =>
      messagingDeps && profile?.userId
        ? new GroupConversationManager(
            messagingDeps.device,
            profile.userId,
            messagingDeps.keystore,
            messagingDeps.sessionKey,
            deviceId ?? null,
          )
        : null,
    [messagingDeps, profile, deviceId],
  );

  const { appendHistory, mergeIncoming, backfillInto } = useConversationBackfill({
    messagingDeps,
    sessionKey,
    setConversations,
  });

  const refreshFriends = useCallback(() => {
    if (refreshFriendsInFlight.current) return refreshFriendsInFlight.current;

    const refresh = (async () => {
      for (let attempt = 0; attempt <= FRIENDS_REFRESH_RETRY_DELAYS_MS.length; attempt += 1) {
        const results = await Promise.allSettled([
          listFriends(),
          listFriendRequests('incoming'),
          listFriendRequests('outgoing'),
        ]);
        const [friendsResult, incomingResult, outgoingResult] = results;

        if (friendsResult.status === 'fulfilled') {
          setFriends(friendsResult.value);
          setFriendsLoaded(true);
        }
        if (incomingResult.status === 'fulfilled') setIncomingRequests(incomingResult.value);
        if (outgoingResult.status === 'fulfilled') setOutgoingRequests(outgoingResult.value);

        const failed = results.some((result) => result.status === 'rejected');
        if (!failed) {
          setFriendsError(false);
          return;
        }

        const retryDelayMs = FRIENDS_REFRESH_RETRY_DELAYS_MS[attempt];
        if (retryDelayMs !== undefined && shouldRetryFriendRefresh(results)) {
          await wait(retryDelayMs);
          continue;
        }

        if (manager) setFriendsError(true);
        return;
      }
    })().finally(() => {
      refreshFriendsInFlight.current = null;
    });

    refreshFriendsInFlight.current = refresh;
    return refresh;
  }, [manager]);

  const refreshFriendsAfterMutation = useCallback(async () => {
    const currentRefresh = refreshFriendsInFlight.current;
    if (currentRefresh) await currentRefresh;
    await refreshFriends();
  }, [refreshFriends]);

  const { liveIds, liveGroups, addLive, connectionStatus, refoldPeerReceiptWatermarks } =
    useLiveConversations({
      device,
      pool,
      deviceId,
      messagingDeps,
      selfUserId: profile?.userId,
      currentUserProfile,
      mergeIncoming,
      backfillInto,
      setConversations,
      onEnrollmentPending: useCallback((id: string) => setPendingEnrollmentId(id), []),
      onPeerKeyChanged: useCallback(
        (_peerUserId: string, conversationId: string, newNumbers: string[]) => {
          setNumbersByConv((prev) => ({ ...prev, [conversationId]: newNumbers[0] ?? '' }));
          setVerifiedByConv((prev) => {
            const next = { ...prev };
            delete next[conversationId];
            return next;
          });
          setPeerKeyChangedConvId(conversationId);
        },
        [],
      ),
      onPeerVerified: useCallback((conversationId: string, safetyNumber: string) => {
        setVerifiedByConv((prev) => ({ ...prev, [conversationId]: safetyNumber }));
      }, []),
      onSafetyNumberResolved: useCallback((conversationId: string, safetyNumber: string) => {
        setNumbersByConv((prev) => ({ ...prev, [conversationId]: safetyNumber }));
      }, []),
      onSyncLost: useCallback((conversationId: string) => {
        setConversations((prev) =>
          prev.map((c) => (c.id === conversationId ? { ...c, recovery: 'sync-lost' as const } : c)),
        );
      }, []),
      onFriendRequest: useCallback(() => {
        void refreshFriends();
      }, [refreshFriends]),
    });

  useConversationHistoryRehydration({
    messagingDeps,
    sessionKey,
    currentUserProfile,
    selfUserId: profile?.userId,
    addLive,
    setConversations,
    onPeerVerified: (conversationId, safetyNumber) => {
      setVerifiedByConv((prev) => ({ ...prev, [conversationId]: safetyNumber }));
      setNumbersByConv((prev) => ({ ...prev, [conversationId]: safetyNumber }));
    },
  });

  useEffect(() => {
    setAnonymousProfile(loadArgusProfile({ subjectId: profileSubjectId }));
  }, [profileSubjectId]);

  useEffect(() => {
    setConversations((prev) =>
      prev.map((conversation) => withCurrentUserProfile(conversation, currentUserProfile)),
    );
  }, [currentUserProfile]);

  useEffect(() => {
    if (manager) void refreshFriends();
  }, [refreshFriends, manager]);

  // Seed the shared privacy cache from the server before read receipts are allowed on fresh devices.
  useEffect(() => {
    let cancelled = false;
    const revisionBeforeFetch = readPrivacySettingsRevision();
    void fetchPrivacySettings()
      .then((settings) => {
        if (cancelled) return;
        if (readPrivacySettingsRevision() !== revisionBeforeFetch) return;
        syncFromServer(settings);
        refoldPeerReceiptWatermarks();
        setPrivacySettingsVersion((version) => version + 1);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refoldPeerReceiptWatermarks]);

  // Build peer↔conversation maps from the server-side enriched conversation list. Used for:
  // (a) dedup: hide stale DMs after peer reinstall, (b) friendship gate: resolve peer userId.
  useEffect(() => {
    if (!manager) return;
    void listMyConversationsWithMeta()
      .then((convs) => {
        const p2c = new Map<string, string>();
        const c2p = new Map<string, string>();
        for (const c of convs) {
          if (!c.isDirect || !c.peerUserId) continue;
          const existing = p2c.get(c.peerUserId);
          if (!existing) {
            p2c.set(c.peerUserId, c.id);
            c2p.set(c.id, c.peerUserId);
          } else {
            c2p.set(c.id, c.peerUserId);
            const existingConv = convs.find((x) => x.id === existing);
            if (existingConv && c.createdAt > existingConv.createdAt) {
              p2c.set(c.peerUserId, c.id);
            }
          }
        }
        convs.forEach((c) => mappedDMConvsRef.current.add(c.id));
        setPeerToConvId(p2c);
        setConvToPeerId(c2p);
        setPeerMapsLoaded(true);
      })
      .catch(() => {
        setPeerMapsLoaded(true);
      });
  }, [manager]);

  // Keep peer maps fresh for DMs that arrive via WebSocket after the startup snapshot.
  useEffect(() => {
    if (!peerMapsLoaded) return;
    const newDMs = conversations.filter(
      (c) => c.type === 'direct' && !mappedDMConvsRef.current.has(c.id),
    );
    if (newDMs.length === 0) return;
    newDMs.forEach((c) => mappedDMConvsRef.current.add(c.id));
    setConvToPeerId((prev) => {
      const next = new Map(prev);
      for (const c of newDMs) {
        const peer =
          loadPersistedPeerMapping(c.id) ??
          c.participants.find((p) => p.id !== currentUserProfile.id)?.id;
        if (peer && !next.has(c.id)) next.set(c.id, peer);
      }
      return next;
    });
    setPeerToConvId((prev) => {
      const next = new Map(prev);
      for (const c of newDMs) {
        const peer =
          loadPersistedPeerMapping(c.id) ??
          c.participants.find((p) => p.id !== currentUserProfile.id)?.id;
        if (peer) next.set(peer, c.id);
      }
      return next;
    });
  }, [conversations, peerMapsLoaded, currentUserProfile.id]);

  // Delivered receipts for ALL conversations — runs regardless of which tab is active.
  useReceiptSending({ conversations, liveIds, selectedId: null, selectedIsLive: false });

  useEffect(() => {
    if ('setAppBadge' in navigator) {
      if (incomingRequests.length > 0) {
        void (navigator as Navigator & { setAppBadge(count?: number): Promise<void> }).setAppBadge(
          incomingRequests.length,
        );
      } else {
        void (navigator as Navigator & { clearAppBadge(): Promise<void> }).clearAppBadge();
      }
    }
  }, [incomingRequests.length]);

  const handleProfileChange = (next: AnonymousProfile): boolean => {
    const safeNext = {
      ...next,
      avatar: safeAvatarSrc(next.avatar, next.username || next.id),
    };
    if (saveArgusProfile({ subjectId: profileSubjectId, profile: safeNext })) {
      setAnonymousProfile(loadArgusProfile({ subjectId: profileSubjectId }));
      return true;
    }
    return false;
  };

  const handleSendFriendRequest = useCallback(
    async (argusId: string) => {
      await sendFriendRequest(argusId);
      await refreshFriendsAfterMutation();
    },
    [refreshFriendsAfterMutation],
  );

  const handleAcceptRequest = useCallback(
    async (requestId: string) => {
      if (inFlightRequestIds.current.has(requestId)) return;
      inFlightRequestIds.current.add(requestId);
      try {
        await acceptFriendRequest(requestId);
        await refreshFriendsAfterMutation();
      } finally {
        inFlightRequestIds.current.delete(requestId);
      }
    },
    [refreshFriendsAfterMutation],
  );

  const handleDeclineRequest = useCallback(
    async (requestId: string) => {
      if (inFlightRequestIds.current.has(requestId)) return;
      inFlightRequestIds.current.add(requestId);
      try {
        await declineFriendRequest(requestId);
        await refreshFriendsAfterMutation();
      } finally {
        inFlightRequestIds.current.delete(requestId);
      }
    },
    [refreshFriendsAfterMutation],
  );

  const handleCancelRequest = useCallback(
    async (requestId: string) => {
      if (inFlightRequestIds.current.has(requestId)) return;
      inFlightRequestIds.current.add(requestId);
      try {
        await cancelFriendRequest(requestId);
        await refreshFriendsAfterMutation();
      } finally {
        inFlightRequestIds.current.delete(requestId);
      }
    },
    [refreshFriendsAfterMutation],
  );

  const handleUnfriend = useCallback(
    async (userId: string) => {
      if (inFlightRequestIds.current.has(userId)) return;
      inFlightRequestIds.current.add(userId);
      try {
        await unfriend(userId);
        await refreshFriendsAfterMutation();
      } finally {
        inFlightRequestIds.current.delete(userId);
      }
    },
    [refreshFriendsAfterMutation],
  );

  const persistStartedConversation = useCallback(
    (session: ConversationSession, peer: UserLookupResult) => {
      const name = contactDisplayName(peer);
      const peerUser: User = {
        id: peer.userId,
        name,
        argusId: peer.argusId,
        avatar: dicebearAvatar(peer.userId),
      };
      addLive(session.conversationId, session.conversation);
      setConversations((prev) =>
        prev.some((c) => c.id === session.conversationId)
          ? prev
          : [
              {
                id: session.conversationId,
                type: 'direct',
                participants: [currentUserProfile, peerUser],
                messages: [],
                unreadCount: 0,
              },
              ...prev,
            ],
      );
      persistPeerMapping(session.conversationId, peer.userId);
      setNumbersByConv((prev) => ({ ...prev, [session.conversationId]: session.safetyNumber }));
      setVerifiedByConv((prev) => ({ ...prev, [session.conversationId]: session.safetyNumber }));

      if (messagingDeps) {
        const { device: dev, keystore: ks, sessionKey: sk } = messagingDeps;
        void (async () => {
          try {
            const members = session.conversation.members();
            const selfSigKey = dev.publicPackage.leafNode.signaturePublicKey;
            const selfMember = members.find((m) => {
              if (m.signaturePublicKey.length !== selfSigKey.length) return false;
              for (let i = 0; i < selfSigKey.length; i++) {
                if (m.signaturePublicKey[i] !== selfSigKey[i]) return false;
              }
              return true;
            });
            if (!selfMember) return;
            const peerMembers = members.filter((m) => m.identity !== selfMember!.identity);
            if (peerMembers.length === 0) return;
            const nums: string[] = await Promise.all(
              peerMembers.map((pm) => safetyNumberFromMember(selfMember, pm)),
            );
            const sorted = [...new Set(nums)].sort();
            await ks.saveVerifiedPeer(peer.userId, sorted, sk);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
              'persistStartedConversation: could not persist verified peer',
              err instanceof Error ? err.message : err,
            );
          }
        })();
      }
    },
    [addLive, currentUserProfile, messagingDeps],
  );

  const persistGroupCreated = useCallback(
    (session: GroupConversationSession) => {
      addLive(session.conversationId, session.conversation);
      const participants: User[] = [
        currentUserProfile,
        ...session.addedUserIds.map((id) => ({
          id,
          name: 'Group member',
          avatar: dicebearAvatar(id),
        })),
      ];
      setConversations((prev) =>
        prev.some((c) => c.id === session.conversationId)
          ? prev
          : [
              {
                id: session.conversationId,
                type: 'group' as const,
                name: session.groupName || undefined,
                avatar: session.groupName ? generatedAvatar(session.groupName) : undefined,
                participants,
                messages: [],
                unreadCount: 0,
                creatorId: profile?.userId,
              },
              ...prev,
            ],
      );
    },
    [addLive, currentUserProfile, profile?.userId],
  );

  const value: ChatContextValue = {
    conversations,
    setConversations,
    manager,
    groupManager,
    messagingDeps,
    liveIds,
    liveGroups,
    addLive,
    connectionStatus,
    appendHistory,
    mergeIncoming,
    backfillInto,
    friends,
    friendsLoaded,
    incomingRequests,
    outgoingRequests,
    friendsError,
    refreshFriends,
    peerToConvId,
    convToPeerId,
    peerMapsLoaded,
    handleSendFriendRequest,
    handleAcceptRequest,
    handleDeclineRequest,
    handleCancelRequest,
    handleUnfriend,
    anonymousProfile,
    currentUserProfile,
    handleProfileChange,
    serverProfile: profile,
    deviceId,
    numbersByConv,
    setNumbersByConv,
    verifiedByConv,
    setVerifiedByConv,
    peerKeyChangedConvId,
    setPeerKeyChangedConvId,
    pendingEnrollmentId,
    setPendingEnrollmentId,
    privacySettingsVersion,
    persistStartedConversation,
    persistGroupCreated,
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
