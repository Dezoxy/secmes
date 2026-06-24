import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageCircle, Unplug, X } from 'lucide-react';
import { safetyNumberFromMember } from '@argus/crypto';
import type { UserLookupResult, Friend, FriendRequest } from '../../lib/api';
import {
  listFriends,
  listFriendRequests,
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
import { getMlsSession } from '../../lib/mls';
import { prefersReducedMotion } from '../../lib/pref';
import { useAuth } from '../auth/AuthContext';
import { demoMode } from '../../lib/auth';
import { ArgusAppIcon } from '../brand/ArgusAppIcon';
import { useDevice } from '../device/DeviceContext';
import { usePwaUpdate } from '../pwa/PwaUpdateContext';
import { ConversationList } from './ConversationList';
import { ChatHeader } from './ChatHeader';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { ImagePreviewModal } from './ImagePreviewModal';
import { StartConversation } from './StartConversation';
import { GroupCreateDialog } from './GroupCreateDialog';
import { contactDisplayName } from './user-label';
import { ApproveDevicePanel } from '../device/ApproveDevicePanel';
import { VerifySecurity } from './VerifySecurity';
import {
  useConversationBackfill,
  useConversationHistoryRehydration,
  useSelectedConversationBackfill,
} from './useConversationBackfill';
import { useChatState } from './useChatState';
import { useLiveConversations } from './useLiveConversations';
import { useMessageSending } from './useMessageSending';
import { useReceiptSending } from './useReceiptSending';
import { loadArgusProfile, saveArgusProfile } from '../settings/argus-profile';
import type { AnonymousProfile } from '../settings/SettingsPanel';
import {
  IconButton,
  Modal,
  ReconnectBanner,
  StateBlock,
  conversationEnterMotion,
  modalBackdropEnterMotion,
  modalPanelEnterMotion,
  paneBackEnterMotion,
  paneBackExitMotion,
} from '../ui';
import type { Conversation, User } from './seed';
import { loadPersistedPeerMapping, persistPeerMapping } from './peer-naming';
import { dicebearAvatar, isCustomPhoto } from '../../lib/dicebear';
import {
  initialConversationsForMode,
  currentUser,
  generatedAvatar,
  MAX_AVATAR_DATA_URI_LENGTH,
  getConversationDisplayName,
  safeAvatarSrc,
} from './seed';

const DEMO_PROFILE_SUBJECT = 'demo-local';
const SettingsPanel = lazy(() =>
  import('../settings/SettingsPanel').then((module) => ({ default: module.SettingsPanel })),
);

/**
 * Chat experience, ported from the reworked design (`~/Downloads`) into the Vite PWA.
 *
 * Conversations come from a local seed, but SENDING runs a real in-browser MLS (RFC 9420) encrypt→
 * decrypt round-trip via @argus/crypto (lib/mls.ts) — proving the E2EE path (a lock appears once a
 * message is through it; a failed round-trip marks it failed, never sent). The live loop swaps the
 * local peer for a remote member over the WS gateway and back-fills history by decrypting fetched
 * ciphertext; it needs the key directory + out-of-band fingerprint verification (#20). No plaintext
 * leaves the browser. The settings button opens profile, privacy, and passkey-security controls.
 */
// LIVE conversations start as a neutral-placeholder shell and are then NAMED via the directory (see
// peer-naming.ts): joins resolve the welcome's verified senderUserId; rehydrates/incoming messages resolve
// their senderUserId. (Membership/sender ids are routing METADATA the server already stores — naming the
// peer client-side leaks nothing new; out-of-band fingerprint verification (#20) stays the trust step.)
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
        ? {
            ...participant,
            name: profile.name,
            avatar: profile.avatar,
            isOnline: profile.isOnline,
          }
        : participant,
    ),
  };
}

interface SettingsPanelFallbackProps {
  onClose: () => void;
}

function SettingsPanelFallback({ onClose }: SettingsPanelFallbackProps) {
  return (
    <Modal
      ariaLabel="Settings"
      onClose={onClose}
      className={`items-center justify-center bg-black/40 backdrop-blur-md sm:p-4 ${modalBackdropEnterMotion}`}
      contentClassName={`absolute inset-0 flex w-full items-center justify-center bg-[#12121a] text-sm text-white/45 shadow-2xl shadow-black/50 sm:static sm:h-[90dvh] sm:max-w-6xl sm:rounded-3xl sm:border sm:border-white/5 ${modalPanelEnterMotion}`}
    >
      <IconButton
        onClick={onClose}
        size="sm"
        aria-label="Close settings"
        className="absolute right-4 top-4 text-white/55 hover:bg-white/[0.06] hover:text-white"
      >
        <X className="h-5 w-5" />
      </IconButton>
      <span>Loading settings...</span>
    </Modal>
  );
}

export default function ChatScreen() {
  const [mounted, setMounted] = useState(false);
  // Demo seed (sample contacts + chats) is for demo mode / E2E only; real (prod) builds start empty so a
  // freshly-registered user never sees fabricated conversations (initialConversationsForMode gates on the
  // build-time VITE_DEMO_MODE flag, never set in prod). selectedId likewise only auto-selects a seed chat.
  const [conversations, setConversations] = useState<Conversation[]>(() =>
    initialConversationsForMode(demoMode),
  );
  const [selectedId, setSelectedId] = useState<string | null>(demoMode ? 'conv-1' : null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [mobileThreadClosing, setMobileThreadClosing] = useState(false);
  const [mobileSidebarReturning, setMobileSidebarReturning] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const mobileThreadBackTimerRef = useRef<number | undefined>(undefined);
  const mobileSidebarReturnTimerRef = useRef<number | undefined>(undefined);
  const [verifyOpen, setVerifyOpen] = useState(false);
  // B2: set when D2 registers an enrollment on this user's account — triggers approval UI on D1.
  const [pendingEnrollmentId, setPendingEnrollmentId] = useState<string | null>(null);
  // Each direct conversation has its own MLS session, so its own safety number (#20).
  const [numbersByConv, setNumbersByConv] = useState<Record<string, string>>({});
  // Per-conversation verification: conversationId → the safety number marked verified for it.
  const [verifiedByConv, setVerifiedByConv] = useState<Record<string, string>>({});
  // Set to a conversationId when the peer's safety numbers changed (reinstall detected) — auto-opens
  // the VerifySecurity panel with a keyChanged banner for that conversation.
  const [peerKeyChangedConvId, setPeerKeyChangedConvId] = useState<string | null>(null);

  const { device, pool, deviceId, keystore, sessionKey } = useDevice();
  const { profile, subjectId } = useAuth();
  const { updateReady, applyUpdate } = usePwaUpdate();
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
  // What every live send/receive needs to seal the advanced ratchet at rest (Slice 5). Null in demo mode and
  // for the breakglass admin (no device). The passkey-PRF session key does the per-op group-state sealing AND
  // the join-time pool reseal.
  const messagingDeps = useMemo<MessagingDeps | null>(
    () => (device && keystore && sessionKey ? { device, keystore, sessionKey } : null),
    [device, keystore, sessionKey],
  );
  // A live conversation manager exists only with an unlocked device (not demo mode). New conversations
  // route through it (claim → #20 gate → create + persist + deliver); demo mode keeps the seed/loopback path.
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
  const [startOpen, setStartOpen] = useState(false);
  const [startPrefillArgusId, setStartPrefillArgusId] = useState<string | undefined>();
  const [groupCreateOpen, setGroupCreateOpen] = useState(false);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<FriendRequest[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<FriendRequest[]>([]);
  const [friendsError, setFriendsError] = useState(false);
  const inFlightRequestIds = useRef(new Set<string>());
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const { appendHistory, mergeIncoming, backfillInto } = useConversationBackfill({
    messagingDeps,
    sessionKey,
    setConversations,
  });

  const refreshFriends = useCallback(async () => {
    try {
      const [fl, inc, out] = await Promise.all([
        listFriends(),
        listFriendRequests('incoming'),
        listFriendRequests('outgoing'),
      ]);
      setFriends(fl);
      setIncomingRequests(inc);
      setOutgoingRequests(out);
      setFriendsError(false);
    } catch {
      // Only surface the stale-data banner when authenticated; in demo/E2E mode failures are expected
      // and silent (no manager → no session token → every call 401s/502s).
      if (manager) setFriendsError(true);
    }
  }, [manager]);

  const { liveIds, liveGroups, addLive, connectionStatus } = useLiveConversations({
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
    // Track 4 slice 5c — a conversation can no longer advance its MLS epoch (the commit it needs was
    // pruned / offline beyond retention). Stamp an "out of sync" affordance; the hook has already dropped
    // the doomed group from liveGroups so the live paths stop attempting it. Re-establishing the
    // conversation (re-add via the member/Welcome path) is slice 5c-2 — v1 surfaces the state.
    onSyncLost: useCallback((conversationId: string) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, recovery: 'sync-lost' as const } : c)),
      );
    }, []),
    onFriendRequest: useCallback(() => {
      void refreshFriends();
    }, [refreshFriends]),
  });

  const { selectedConversation, isDirect, selectedIsLive, currentNumber, verified, isLive } =
    useChatState({
      conversations,
      selectedId,
      liveIds,
      numbersByConv,
      verifiedByConv,
    });
  // In demo mode (E2E / no auth) all seed conversations behave as live so the composer renders.
  // The hooks that consume the real selectedIsLive (receipt-sending, backfill) already guard on
  // messagingDeps, which is null in demo mode, so they remain no-ops.
  const effectiveSelectedIsLive = demoMode ? !!selectedId : selectedIsLive;
  // Track 4 slice 5c — the selected conversation is sync-lost (its doomed MLS group was dropped from
  // liveGroups). Show the "out of sync" affordance and suppress the composer: there is no live group to
  // encrypt into, and v1 does not auto-recover (re-establishment is slice 5c-2).
  const selectedIsSyncLost = selectedConversation?.recovery === 'sync-lost';

  const handleSend = useMessageSending({
    selectedId,
    isLive,
    liveGroups,
    messagingDeps,
    appendHistory,
    setConversations,
  });

  useReceiptSending({ conversations, liveIds, selectedId, selectedIsLive });

  useEffect(() => {
    setMounted(true);
  }, []);

  // When a peer key-change is detected for the currently-selected conversation, open the Verify panel
  // automatically so the user sees the warning without having to click Verify manually.
  useEffect(() => {
    if (peerKeyChangedConvId !== null && peerKeyChangedConvId === selectedId) {
      setVerifyOpen(true);
    }
  }, [peerKeyChangedConvId, selectedId]);

  useEffect(() => {
    return () => {
      if (mobileThreadBackTimerRef.current !== undefined) {
        window.clearTimeout(mobileThreadBackTimerRef.current);
      }
      if (mobileSidebarReturnTimerRef.current !== undefined) {
        window.clearTimeout(mobileSidebarReturnTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setAnonymousProfile(loadArgusProfile({ subjectId: profileSubjectId }));
  }, [profileSubjectId]);

  useEffect(() => {
    setConversations((prev) =>
      prev.map((conversation) => withCurrentUserProfile(conversation, currentUserProfile)),
    );
  }, [currentUserProfile]);

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

  // A 1:1 is unique per peer: find an existing direct conversation with this user (the picker opens it
  // ── Friends (Slice E) ────────────────────────────────────────────────────────

  useEffect(() => {
    if (manager) void refreshFriends();
  }, [refreshFriends, manager]);

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

  const handleTapFriend = useCallback(
    (friend: Friend) => {
      const existingId =
        conversations.find(
          (c) => c.type === 'direct' && c.participants.some((p) => p.id === friend.userId),
        )?.id ?? null;
      if (existingId) {
        if (mobileThreadBackTimerRef.current !== undefined)
          window.clearTimeout(mobileThreadBackTimerRef.current);
        if (mobileSidebarReturnTimerRef.current !== undefined)
          window.clearTimeout(mobileSidebarReturnTimerRef.current);
        setMobileThreadClosing(false);
        setMobileSidebarReturning(false);
        setSelectedId(existingId);
        if (window.innerWidth < 1024) setShowSidebar(false);
        setStartOpen(false);
        return;
      }
      setStartPrefillArgusId(friend.argusId ?? undefined);
      setStartOpen(true);
    },
    [conversations],
  );

  const handleSendFriendRequest = useCallback(
    async (argusId: string) => {
      await sendFriendRequest(argusId);
      await refreshFriends();
    },
    [refreshFriends],
  );

  const handleAcceptRequest = useCallback(
    async (requestId: string) => {
      if (inFlightRequestIds.current.has(requestId)) return;
      inFlightRequestIds.current.add(requestId);
      try {
        await acceptFriendRequest(requestId);
        await refreshFriends();
      } finally {
        inFlightRequestIds.current.delete(requestId);
      }
    },
    [refreshFriends],
  );

  const handleDeclineRequest = useCallback(
    async (requestId: string) => {
      if (inFlightRequestIds.current.has(requestId)) return;
      inFlightRequestIds.current.add(requestId);
      try {
        await declineFriendRequest(requestId);
        await refreshFriends();
      } finally {
        inFlightRequestIds.current.delete(requestId);
      }
    },
    [refreshFriends],
  );

  const handleCancelRequest = useCallback(
    async (requestId: string) => {
      if (inFlightRequestIds.current.has(requestId)) return;
      inFlightRequestIds.current.add(requestId);
      try {
        await cancelFriendRequest(requestId);
        await refreshFriends();
      } finally {
        inFlightRequestIds.current.delete(requestId);
      }
    },
    [refreshFriends],
  );

  const handleUnfriend = useCallback(
    async (userId: string) => {
      if (inFlightRequestIds.current.has(userId)) return;
      inFlightRequestIds.current.add(userId);
      try {
        await unfriend(userId);
        await refreshFriends();
      } finally {
        inFlightRequestIds.current.delete(userId);
      }
    },
    [refreshFriends],
  );

  // ─────────────────────────────────────────────────────────────────────────────

  // instead of creating a duplicate). Matches on the REAL peer user id, which creator-made conversations
  // carry from the start and joined/rehydrated ones gain via peer-naming (or the persisted mapping on
  // reload — see persistPeerMapping in handleStarted below and useConversationHistoryRehydration).
  const findConversationWith = (peerUserId: string): string | null =>
    conversations.find(
      (c) => c.type === 'direct' && c.participants.some((p) => p.id === peerUserId),
    )?.id ?? null;

  const handleOpenExisting = (conversationId: string): void => {
    setSelectedId(conversationId);
    setStartOpen(false);
    setStartPrefillArgusId(undefined);
  };

  // Add a freshly-started LIVE conversation to the list: its safety number is the REAL one from the
  // session (not a loopback), and the user just confirmed it out-of-band, so it lands pre-verified.
  const handleStarted = (session: ConversationSession, peer: UserLookupResult): void => {
    const name = contactDisplayName(peer);
    const peerUser: User = {
      id: peer.userId,
      name,
      argusId: peer.argusId,
      avatar: dicebearAvatar(peer.userId),
      // No isOnline: presence is unknown for live peers — never claim Offline (see seed.ts User).
    };
    addLive(session.conversationId, session.conversation); // retain its MLS group for live send/fetch
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
    setSelectedId(session.conversationId);
    setStartOpen(false);
    setStartPrefillArgusId(undefined);
    // Persist the verified safety-number set keyed by peerUserId. Computed from the group roster
    // post-confirm using safetyNumberFromMember for cross-consistency with the joiner path (C2).
    if (messagingDeps) {
      const { device, keystore, sessionKey } = messagingDeps;
      void (async () => {
        try {
          const members = session.conversation.members();
          const selfSigKey = device.publicPackage.leafNode.signaturePublicKey;
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
          await keystore.saveVerifiedPeer(peer.userId, sorted, sessionKey);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            'handleStarted: could not persist verified peer',
            err instanceof Error ? err.message : err,
          );
        }
      })();
    }
  };

  const handleGroupCreated = (session: GroupConversationSession): void => {
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
    setSelectedId(session.conversationId);
    setGroupCreateOpen(false);
  };

  const handleOpenAddMember = (): void => {
    if (!selectedId) return;
    if (!liveGroups.current.has(selectedId)) return;
    setAddMemberOpen(true);
  };

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

  // Compute the selected DIRECT conversation's own safety number (from its own loopback session), once.
  // LIVE conversations are skipped — a started one already holds its REAL number, and none should spin up a
  // loopback session (which would compute the wrong, local number). A sync-lost conversation is a real live
  // one that was dropped from liveIds (so selectedIsLive is now false); skip it too so we never spin up a
  // bogus loopback session against its id (Track 4 slice 5c).
  useEffect(() => {
    if (!selectedId || !isDirect || selectedIsLive || selectedIsSyncLost) return;
    void getMlsSession(selectedId)
      .then((s) =>
        setNumbersByConv((prev) =>
          prev[selectedId] ? prev : { ...prev, [selectedId]: s.safetyNumber },
        ),
      )
      .catch(() => {});
  }, [selectedId, isDirect, selectedIsLive, selectedIsSyncLost]);

  useSelectedConversationBackfill({
    selectedId,
    selectedIsLive,
    selfUserId: profile?.userId,
    liveGroups,
    backfillInto,
  });

  const handleSelect = (id: string) => {
    if (mobileThreadBackTimerRef.current !== undefined) {
      window.clearTimeout(mobileThreadBackTimerRef.current);
    }
    if (mobileSidebarReturnTimerRef.current !== undefined) {
      window.clearTimeout(mobileSidebarReturnTimerRef.current);
    }
    setMobileThreadClosing(false);
    setMobileSidebarReturning(false);
    setSelectedId(id);
    if (window.innerWidth < 1024) setShowSidebar(false);
  };

  const handleBackToConversations = () => {
    if (window.innerWidth >= 1024 || prefersReducedMotion()) {
      setShowSidebar(true);
      return;
    }

    if (mobileThreadBackTimerRef.current !== undefined) {
      window.clearTimeout(mobileThreadBackTimerRef.current);
    }
    if (mobileSidebarReturnTimerRef.current !== undefined) {
      window.clearTimeout(mobileSidebarReturnTimerRef.current);
    }

    setMobileThreadClosing(true);
    mobileThreadBackTimerRef.current = window.setTimeout(() => {
      setShowSidebar(true);
      setMobileThreadClosing(false);
      setMobileSidebarReturning(true);
      mobileSidebarReturnTimerRef.current = window.setTimeout(() => {
        setMobileSidebarReturning(false);
      }, 220);
    }, 180);
  };

  const openSettings = (trigger: HTMLButtonElement) => {
    settingsReturnFocusRef.current = trigger;
    setSettingsOpen(true);
  };

  const closeSettings = () => {
    setSettingsOpen(false);
    window.requestAnimationFrame(() => settingsReturnFocusRef.current?.focus());
  };

  return (
    <div className="h-[100dvh] bg-[#1a1a24] flex sm:items-center sm:justify-center sm:p-4">
      <div
        className={`absolute inset-0 w-full sm:static sm:h-[90dvh] sm:max-w-6xl bg-[#12121a] sm:rounded-3xl overflow-hidden flex shadow-2xl shadow-black/50 transition-all duration-700 ease-out ${
          mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
        }`}
      >
        {/* Sidebar */}
        <aside
          aria-label="Conversations"
          className={`${
            showSidebar && !mobileThreadClosing ? 'flex' : 'hidden lg:flex'
          } w-full lg:w-80 shrink-0 flex-col bg-[#0f0f16] border-r border-white/5 transition-all duration-500 ${
            mounted ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-8'
          } ${mobileSidebarReturning ? paneBackEnterMotion : ''}`}
        >
          <div className="border-b border-white/5 bg-[#0f0f16]/75 p-4 pt-[calc(env(safe-area-inset-top)_+_1rem)] backdrop-blur-xl">
            <div className="flex items-center justify-center gap-2">
              <ArgusAppIcon className="h-8 w-8 rounded-lg shadow-sm shadow-purple-500/25" />
              <span className="text-xl font-bold tracking-wider">
                <span className="bg-gradient-to-r from-purple-400 to-purple-600 bg-clip-text text-transparent">
                  ARGUS
                </span>
              </span>
            </div>
          </div>

          <ConversationList
            conversations={conversations}
            selectedId={selectedId}
            onSelect={handleSelect}
            currentUserProfile={currentUserProfile}
            onSettings={openSettings}
            onNewGroup={groupManager ? () => setGroupCreateOpen(true) : undefined}
            updateReady={updateReady}
            onApplyUpdate={applyUpdate}
            friends={friends}
            incomingRequests={incomingRequests}
            outgoingRequests={outgoingRequests}
            friendsLoadError={friendsError}
            onFriendsOpen={refreshFriends}
            onTapFriend={manager ? handleTapFriend : undefined}
            onSendFriendRequest={manager ? handleSendFriendRequest : undefined}
            onAcceptRequest={manager ? handleAcceptRequest : undefined}
            onDeclineRequest={manager ? handleDeclineRequest : undefined}
            onCancelRequest={manager ? handleCancelRequest : undefined}
            onUnfriend={manager ? handleUnfriend : undefined}
          />
        </aside>

        {/* Main */}
        <div
          role="main"
          aria-label="Chat"
          className={`${
            !showSidebar || mobileThreadClosing ? 'flex' : 'hidden lg:flex'
          } flex-1 flex-col transition-all duration-500 delay-100 ${
            mounted ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-8'
          } ${mobileThreadClosing ? paneBackExitMotion : ''}`}
        >
          {selectedConversation ? (
            <div
              key={selectedConversation.id}
              className={`flex min-h-0 flex-1 flex-col ${conversationEnterMotion}`}
            >
              <ChatHeader
                conversation={selectedConversation}
                onBack={handleBackToConversations}
                verified={verified}
                onVerify={isDirect && currentNumber ? () => setVerifyOpen(true) : undefined}
                onAddMember={
                  selectedConversation.type === 'group' &&
                  selectedConversation.creatorId === profile?.userId &&
                  groupManager !== null &&
                  !selectedIsSyncLost // a sync-lost group has no live group to add into (5c)
                    ? handleOpenAddMember
                    : undefined
                }
                updateReady={updateReady}
                onApplyUpdate={applyUpdate}
              />
              {effectiveSelectedIsLive && !selectedIsSyncLost && (
                <ReconnectBanner status={connectionStatus} className="mx-4 mt-3" />
              )}
              {selectedIsSyncLost && (
                <StateBlock
                  icon={Unplug}
                  title="Conversation out of sync"
                  variant="offline"
                  compact
                  role="status"
                  ariaLive="polite"
                  className="mx-4 mt-3"
                >
                  This conversation fell too far behind to sync. New messages may not appear and
                  older ones may be unavailable.
                </StateBlock>
              )}
              <MessageList conversation={selectedConversation} onImageClick={setPreviewImage} />
              {effectiveSelectedIsLive && !selectedIsSyncLost && <ChatInput onSend={handleSend} />}
            </div>
          ) : (
            <div
              key="empty-conversation"
              className={`flex flex-1 flex-col items-center justify-center p-8 text-center ${conversationEnterMotion}`}
            >
              <div className="w-20 h-20 bg-purple-500/20 rounded-full flex items-center justify-center mb-4">
                <MessageCircle className="w-10 h-10 text-purple-400" />
              </div>
              <h2 className="text-xl font-semibold text-white mb-2">Welcome to Argus</h2>
              <p className="text-white/60 max-w-sm">
                Select a conversation from the sidebar to start messaging
              </p>
            </div>
          )}
        </div>
      </div>

      <ImagePreviewModal imageUrl={previewImage} onClose={() => setPreviewImage(null)} />
      {settingsOpen && (
        <Suspense fallback={<SettingsPanelFallback onClose={closeSettings} />}>
          <SettingsPanel
            profile={anonymousProfile}
            deviceId={deviceId}
            serverHandle={profile?.displayName ?? null}
            serverProfile={profile}
            onProfileChange={handleProfileChange}
            onClose={closeSettings}
          />
        </Suspense>
      )}
      {startOpen && manager && (
        <StartConversation
          manager={manager}
          selfUserId={profile?.userId}
          existingConversationWith={findConversationWith}
          onOpenExisting={handleOpenExisting}
          onStarted={handleStarted}
          prefillArgusId={startPrefillArgusId}
          onClose={() => {
            setStartOpen(false);
            setStartPrefillArgusId(undefined);
          }}
        />
      )}
      {groupCreateOpen && groupManager && messagingDeps && (
        <GroupCreateDialog
          mode="create"
          manager={groupManager}
          deps={messagingDeps}
          selfUserId={profile?.userId}
          onCreated={handleGroupCreated}
          onClose={() => setGroupCreateOpen(false)}
        />
      )}
      {addMemberOpen && selectedId && groupManager && messagingDeps && (
        <GroupCreateDialog
          mode="add"
          manager={groupManager}
          deps={messagingDeps}
          selfUserId={profile?.userId}
          conversationId={selectedId}
          existingConversation={liveGroups.current.get(selectedId)}
          existingMemberIds={new Set(selectedConversation?.participants.map((p) => p.id) ?? [])}
          existingGroupName={selectedConversation?.name}
          onAdded={(addedUsers) => {
            setAddMemberOpen(false);
            if (addedUsers.length > 0 && selectedId) {
              setConversations((prev) =>
                prev.map((c) => {
                  if (c.id !== selectedId) return c;
                  const existingIds = new Set(c.participants.map((p) => p.id));
                  const fresh = addedUsers
                    .filter((u) => !existingIds.has(u.userId))
                    .map((u) => ({
                      id: u.userId,
                      name: contactDisplayName(u),
                      argusId: u.argusId,
                      avatar: dicebearAvatar(u.userId),
                    }));
                  return fresh.length === 0
                    ? c
                    : { ...c, participants: [...c.participants, ...fresh] };
                }),
              );
            }
          }}
          onClose={() => setAddMemberOpen(false)}
        />
      )}
      {pendingEnrollmentId && profile?.userId && (
        <ApproveDevicePanel
          enrollmentId={pendingEnrollmentId}
          selfUserId={profile.userId}
          messagingDeps={messagingDeps}
          liveGroupsRef={liveGroups}
          onClose={() => setPendingEnrollmentId(null)}
        />
      )}
      {verifyOpen && isDirect && (
        <VerifySecurity
          peerName={
            selectedConversation
              ? getConversationDisplayName(selectedConversation, currentUser.id)
              : 'this contact'
          }
          safetyNumber={currentNumber}
          verified={verified}
          keyChanged={selectedId !== null && peerKeyChangedConvId === selectedId}
          onVerifiedChange={(v) => {
            setVerifiedByConv((prev) => {
              const next = { ...prev };
              if (v && selectedId && currentNumber) next[selectedId] = currentNumber;
              else if (selectedId) delete next[selectedId];
              return next;
            });
            // Clear the key-changed flag and persist the full per-member verified set on explicit confirm.
            if (v && selectedId) setPeerKeyChangedConvId(null);
            if (selectedId && messagingDeps) {
              const { device, keystore, sessionKey } = messagingDeps;
              const peerUserId = loadPersistedPeerMapping(selectedId);
              if (peerUserId) {
                if (!v) {
                  // User explicitly unverified — remove the persisted record so a later reload does not
                  // silently restore the verified badge via loadVerifiedPeer.
                  void keystore.deleteVerifiedPeer(peerUserId);
                } else {
                  // Use the persisted peerUserId (set on handleStarted / join) — not the participant.id from
                  // the conversation list, which may still be the placeholder when the directory lookup is pending.
                  const liveGroup = liveGroups.current.get(selectedId);
                  if (liveGroup) {
                    void (async () => {
                      try {
                        const members = liveGroup.members();
                        const selfSigKey = device.publicPackage.leafNode.signaturePublicKey;
                        const selfMember = members.find((m) => {
                          if (m.signaturePublicKey.length !== selfSigKey.length) return false;
                          for (let i = 0; i < selfSigKey.length; i++) {
                            if (m.signaturePublicKey[i] !== selfSigKey[i]) return false;
                          }
                          return true;
                        });
                        if (!selfMember) return;
                        const peerMembers = members.filter(
                          (m) => m.identity !== selfMember!.identity,
                        );
                        if (peerMembers.length === 0) return;
                        const nums: string[] = await Promise.all(
                          peerMembers.map((pm) => safetyNumberFromMember(selfMember, pm)),
                        );
                        const sorted = [...new Set(nums)].sort();
                        await keystore.saveVerifiedPeer(peerUserId, sorted, sessionKey);
                      } catch (err) {
                        // eslint-disable-next-line no-console
                        console.warn(
                          'could not persist verified peer',
                          err instanceof Error ? err.message : err,
                        );
                      }
                    })();
                  }
                }
              }
            }
          }}
          onClose={() => {
            setVerifyOpen(false);
          }}
        />
      )}
    </div>
  );
}
