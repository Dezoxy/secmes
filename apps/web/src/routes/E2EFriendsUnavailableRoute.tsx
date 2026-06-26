import { useCallback, useMemo, useRef, useState } from 'react';
import FriendsScreen from '../features/friends/FriendsScreen';
import { ChatContext, type ChatContextValue } from '../features/chat/ChatContext';
import { currentUser, generatedAvatar, type Conversation } from '../features/chat/seed';
import type { Friend, MeBound } from '../lib/api';

function isFriend(value: unknown): value is Friend {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['userId'] === 'string' &&
    typeof record['argusId'] === 'string' &&
    (record['displayName'] === null || typeof record['displayName'] === 'string') &&
    (record['avatarSeed'] === null || typeof record['avatarSeed'] === 'string') &&
    typeof record['since'] === 'string'
  );
}

function parseFriends(value: unknown): Friend[] {
  if (!value || typeof value !== 'object') return [];
  const friends = (value as Record<string, unknown>)['friends'];
  return Array.isArray(friends) ? friends.filter(isFriend) : [];
}

export default function E2EFriendsUnavailableRoute() {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [friendsLoaded, setFriendsLoaded] = useState(false);
  const [friendsError, setFriendsError] = useState(true);
  const liveGroups = useRef(new Map());

  const refreshFriends = useCallback(async () => {
    try {
      const res = await fetch('/api/friends');
      if (!res.ok) throw new Error(`status ${res.status}`);
      setFriends(parseFriends(await res.json()));
      setFriendsLoaded(true);
      setFriendsError(false);
    } catch {
      setFriends([]);
      setFriendsLoaded(false);
      setFriendsError(true);
    }
  }, []);

  const value = useMemo<ChatContextValue>(
    () => ({
      conversations: [] as Conversation[],
      setConversations: () => undefined,
      manager: {} as ChatContextValue['manager'],
      groupManager: null,
      messagingDeps: null,
      liveIds: new Set<string>(),
      liveGroups,
      addLive: () => undefined,
      connectionStatus: 'connected',
      appendHistory: () => undefined,
      mergeIncoming: () => undefined,
      backfillInto: async () => ({ nextEpoch: undefined }),
      friends,
      friendsLoaded,
      incomingRequests: [],
      outgoingRequests: [],
      friendsError,
      refreshFriends,
      peerToConvId: new Map(),
      convToPeerId: new Map(),
      peerMapsLoaded: true,
      handleSendFriendRequest: async () => undefined,
      handleAcceptRequest: async () => undefined,
      handleDeclineRequest: async () => undefined,
      handleCancelRequest: async () => undefined,
      handleUnfriend: async () => undefined,
      anonymousProfile: {
        id: 'e2e-profile',
        username: 'E2E User',
        avatar: generatedAvatar('E2E User'),
      },
      currentUserProfile: currentUser,
      handleProfileChange: () => true,
      serverProfile: { userId: currentUser.id, displayName: currentUser.name } as MeBound,
      deviceId: 'e2e-device',
      numbersByConv: {},
      setNumbersByConv: () => undefined,
      verifiedByConv: {},
      setVerifiedByConv: () => undefined,
      peerKeyChangedConvId: null,
      setPeerKeyChangedConvId: () => undefined,
      pendingEnrollmentId: null,
      setPendingEnrollmentId: () => undefined,
      privacySettingsVersion: 0,
      persistStartedConversation: () => undefined,
      persistGroupCreated: () => undefined,
    }),
    [friends, friendsError, friendsLoaded, refreshFriends],
  );

  return (
    <main className="h-[100dvh] bg-[#12121a] text-white">
      <ChatContext.Provider value={value}>
        <FriendsScreen />
      </ChatContext.Provider>
    </main>
  );
}
