import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageCircle, Search, Unplug, X } from 'lucide-react';
import { getMlsSession } from '../../lib/mls';
import { prefersReducedMotion } from '../../lib/pref';
import { demoMode } from '../../lib/auth';
import { ArgusAppIcon } from '../brand/ArgusAppIcon';
import { ConversationList } from './ConversationList';
import { ChatHeader } from './ChatHeader';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { ImagePreviewModal } from './ImagePreviewModal';
import { StartConversation } from './StartConversation';
import { GroupCreateDialog } from './GroupCreateDialog';
import { ApproveDevicePanel } from '../device/ApproveDevicePanel';
import { VerifySecurity } from './VerifySecurity';
import { useSelectedConversationBackfill } from './useConversationBackfill';
import { tabSelectedId } from './tabSelectedId';
import { useChatState } from './useChatState';
import { useMessageSending } from './useMessageSending';
import { useReceiptSending } from './useReceiptSending';
import { useChatContext } from './ChatContext';
import { MUTES_CHANGED_EVENT, readMutedConversationIds } from '../settings/conversation-mute';
import {
  ReconnectBanner,
  StateBlock,
  conversationEnterMotion,
  paneBackEnterMotion,
  paneBackExitMotion,
} from '../ui';
import { useSwipeBack } from '../ui/useSwipeBack';
import { currentUser, getConversationDisplayName } from './seed';
import { loadPersistedPeerMapping } from './peer-naming';
import { contactDisplayName } from './user-label';
import { dicebearAvatar } from '../../lib/dicebear';
import { safetyNumberFromMember } from '@argus/crypto';
import { useLocation } from 'react-router-dom';
import { useSetNavVisible } from '../../routes/NavVisibilityContext';

export default function ChatScreen() {
  const setNavVisible = useSetNavVisible();
  const location = useLocation();
  const locationState = location.state as
    | { selectedId?: string; startArgusId?: string }
    | null
    | undefined;

  const {
    conversations,
    setConversations,
    manager,
    groupManager,
    messagingDeps,
    liveIds,
    liveGroups,
    connectionStatus,
    appendHistory,
    backfillInto,
    serverProfile: profile,
    numbersByConv,
    setNumbersByConv,
    verifiedByConv,
    setVerifiedByConv,
    peerKeyChangedConvId,
    setPeerKeyChangedConvId,
    pendingEnrollmentId,
    setPendingEnrollmentId,
    persistStartedConversation,
    friends,
    friendsLoaded,
    peerToConvId,
    convToPeerId,
    peerMapsLoaded,
    privacySettingsVersion,
  } = useChatContext();

  const [mounted, setMounted] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(
    demoMode ? 'conv-1' : (locationState?.selectedId ?? tabSelectedId.get('/chat') ?? null),
  );
  useEffect(() => {
    if (!demoMode) tabSelectedId.set('/chat', selectedId);
  }, [selectedId]);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(!locationState?.selectedId);
  const [mobileThreadClosing, setMobileThreadClosing] = useState(false);
  const [mobileSidebarReturning, setMobileSidebarReturning] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [startOpen, setStartOpen] = useState(!!locationState?.startArgusId);
  const [startPrefillArgusId, setStartPrefillArgusId] = useState<string | undefined>(
    locationState?.startArgusId,
  );
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const mobileThreadBackTimerRef = useRef<number | undefined>(undefined);
  const mobileSidebarReturnTimerRef = useRef<number | undefined>(undefined);
  const mainPanelRef = useRef<HTMLDivElement>(null);
  const [mutedConversationIds, setMutedConversationIds] = useState<ReadonlySet<string>>(() =>
    readMutedConversationIds(),
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef<number | null>(null);
  const sidebarTouchStartY = useRef<number | null>(null);
  const searchTouchStartY = useRef<number | null>(null);

  const { selectedConversation, isDirect, selectedIsLive, currentNumber, verified, isLive } =
    useChatState({ conversations, selectedId, liveIds, numbersByConv, verifiedByConv });

  const effectiveSelectedIsLive = demoMode ? !!selectedId : selectedIsLive;
  const selectedIsSyncLost = selectedConversation?.recovery === 'sync-lost';

  // Resolve peer userId for the selected DM: prefer server-side map, then localStorage, then participants.
  const selectedPeerUserId = useMemo(() => {
    if (!selectedId || !isDirect) return null;
    return (
      convToPeerId.get(selectedId) ??
      loadPersistedPeerMapping(selectedId) ??
      selectedConversation?.participants.find((p) => p.id !== profile?.userId)?.id ??
      null
    );
  }, [selectedId, isDirect, convToPeerId, selectedConversation, profile?.userId]);

  // Block the DM composer when the peer is no longer an accepted friend. Guard on friendsLoaded
  // to avoid false-blocking before the first fetch, and on UUID_RE to skip synthetic placeholder IDs.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const peerIsFriend =
    !isDirect ||
    !selectedPeerUserId ||
    !friendsLoaded ||
    !UUID_RE.test(selectedPeerUserId) ||
    friends.some((f) => f.userId === selectedPeerUserId);

  // Sidebar dedup: hide stale duplicate DMs after peer reinstall.
  const localConvIds = useMemo(() => new Set(conversations.map((c) => c.id)), [conversations]);
  const dedupedConversations = useMemo(
    () =>
      !peerMapsLoaded
        ? conversations
        : conversations.filter((c) => {
            if (c.type !== 'direct') return true;
            const peer = convToPeerId.get(c.id);
            if (!peer) return true;
            const canonicalId = peerToConvId.get(peer);
            if (canonicalId && canonicalId !== c.id && localConvIds.has(canonicalId)) return false;
            return true;
          }),
    [conversations, peerMapsLoaded, peerToConvId, convToPeerId, localConvIds],
  );

  const revealSearch = () => setSearchOpen(true);

  const hideSearch = () => {
    searchInputRef.current?.blur();
    setSearchFocused(false);
    setSearchOpen(false);
    setSearchQuery('');
  };

  const hideSearchIfIdle = () => {
    if (!searchFocused) setSearchOpen(false);
  };

  const focusSearch = () => {
    revealSearch();
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  };

  const handleSearchWheel = (event: React.WheelEvent<HTMLElement>) => {
    if (event.deltaY > 12) hideSearch();
  };

  const handleSearchTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    searchTouchStartY.current = event.touches[0]?.clientY ?? null;
  };

  const handleSearchTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const startY = searchTouchStartY.current;
    const currentY = event.touches[0]?.clientY;
    if (startY === null || currentY === undefined) return;
    if (currentY - startY < -28) hideSearch();
  };

  const handleSearchTouchEnd = () => {
    searchTouchStartY.current = null;
  };

  const handleSidebarWheelCapture = (event: React.WheelEvent<HTMLDivElement>) => {
    if (searchOpen && event.deltaY > 12) hideSearch();
  };

  const handleSidebarTouchStartCapture = (event: React.TouchEvent<HTMLDivElement>) => {
    if (searchOpen) sidebarTouchStartY.current = event.touches[0]?.clientY ?? null;
  };

  const handleSidebarTouchMoveCapture = (event: React.TouchEvent<HTMLDivElement>) => {
    const startY = sidebarTouchStartY.current;
    const currentY = event.touches[0]?.clientY;
    if (startY === null || currentY === undefined) return;
    if (currentY - startY < -28) hideSearch();
  };

  const handleSidebarTouchEndCapture = () => {
    sidebarTouchStartY.current = null;
  };

  const handleListWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const scrollTop = listRef.current?.scrollTop ?? 0;
    if (event.deltaY < -12 && scrollTop <= 2) revealSearch();
    if (event.deltaY > 12) {
      if (searchOpen) hideSearch();
      else if (scrollTop > 12) hideSearchIfIdle();
    }
  };

  const handleListTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (searchOpen || (listRef.current?.scrollTop ?? 0) <= 2) {
      touchStartY.current = event.touches[0]?.clientY ?? null;
    }
  };

  const handleListTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const startY = touchStartY.current;
    const currentY = event.touches[0]?.clientY;
    if (startY === null || currentY === undefined) return;
    if (currentY - startY > 28 && (listRef.current?.scrollTop ?? 0) <= 2) revealSearch();
    if (currentY - startY < -28 && searchOpen) hideSearch();
  };

  const handleListTouchEnd = () => {
    touchStartY.current = null;
  };

  const filteredConversations = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return dedupedConversations;
    return dedupedConversations.filter((c) =>
      getConversationDisplayName(c, currentUser.id).toLowerCase().includes(q),
    );
  }, [dedupedConversations, searchQuery]);

  const handleSend = useMessageSending({
    selectedId,
    isLive,
    liveGroups,
    messagingDeps,
    appendHistory,
    setConversations,
  });

  // Read receipts only — delivered receipts are handled globally by ChatProvider.
  useReceiptSending({
    conversations,
    liveIds,
    selectedId,
    selectedIsLive,
    sendDelivered: false,
    privacySettingsVersion,
  });

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const update = () => setNavVisible(mq.matches || showSidebar);
    update();
    mq.addEventListener('change', update);
    return () => {
      mq.removeEventListener('change', update);
      setNavVisible(true);
    };
  }, [showSidebar, setNavVisible]);

  useEffect(() => {
    if (peerKeyChangedConvId !== null && peerKeyChangedConvId === selectedId) {
      setVerifyOpen(true);
    }
  }, [peerKeyChangedConvId, selectedId]);

  useEffect(() => {
    return () => {
      if (mobileThreadBackTimerRef.current !== undefined)
        window.clearTimeout(mobileThreadBackTimerRef.current);
      if (mobileSidebarReturnTimerRef.current !== undefined)
        window.clearTimeout(mobileSidebarReturnTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const refreshMutedConversations = () => setMutedConversationIds(readMutedConversationIds());
    window.addEventListener(MUTES_CHANGED_EVENT, refreshMutedConversations);
    return () => window.removeEventListener(MUTES_CHANGED_EVENT, refreshMutedConversations);
  }, []);

  // Redirect selection away from a stale duplicate DM when the canonical replacement is present locally.
  useEffect(() => {
    if (!selectedId || !peerMapsLoaded) return;
    const peer = convToPeerId.get(selectedId);
    if (!peer) return;
    const canonicalId = peerToConvId.get(peer);
    if (!canonicalId || canonicalId === selectedId) return;
    if (!localConvIds.has(canonicalId)) return;
    setSelectedId(canonicalId);
  }, [selectedId, peerMapsLoaded, convToPeerId, peerToConvId, localConvIds]);

  // Compute the loopback safety number for direct non-live conversations.
  useEffect(() => {
    if (!selectedId || !isDirect || selectedIsLive || selectedIsSyncLost) return;
    void getMlsSession(selectedId)
      .then((s) =>
        setNumbersByConv((prev) =>
          prev[selectedId] ? prev : { ...prev, [selectedId]: s.safetyNumber },
        ),
      )
      .catch(() => {});
  }, [selectedId, isDirect, selectedIsLive, selectedIsSyncLost, setNumbersByConv]);

  useSelectedConversationBackfill({
    selectedId,
    selectedIsLive,
    selfUserId: profile?.userId,
    liveGroups,
    backfillInto,
  });

  const handleSelect = (id: string) => {
    if (mobileThreadBackTimerRef.current !== undefined)
      window.clearTimeout(mobileThreadBackTimerRef.current);
    if (mobileSidebarReturnTimerRef.current !== undefined)
      window.clearTimeout(mobileSidebarReturnTimerRef.current);
    setMobileThreadClosing(false);
    setMobileSidebarReturning(false);
    setSelectedId(id);
    if (window.innerWidth < 1024) setShowSidebar(false);
  };

  const handleBackToConversations = useCallback(() => {
    if (window.innerWidth >= 1024 || prefersReducedMotion()) {
      setShowSidebar(true);
      return;
    }
    if (mobileThreadBackTimerRef.current !== undefined)
      window.clearTimeout(mobileThreadBackTimerRef.current);
    if (mobileSidebarReturnTimerRef.current !== undefined)
      window.clearTimeout(mobileSidebarReturnTimerRef.current);
    setMobileThreadClosing(true);
    mobileThreadBackTimerRef.current = window.setTimeout(() => {
      setShowSidebar(true);
      setMobileThreadClosing(false);
      setMobileSidebarReturning(true);
      mobileSidebarReturnTimerRef.current = window.setTimeout(() => {
        setMobileSidebarReturning(false);
      }, 220);
    }, 180);
  }, []);

  useSwipeBack(mainPanelRef, handleBackToConversations, !showSidebar);

  const findConversationWith = (peerUserId: string): string | null =>
    peerToConvId.get(peerUserId) ??
    conversations.find(
      (c) => c.type === 'direct' && c.participants.some((p) => p.id === peerUserId),
    )?.id ??
    null;

  const conversationHasState = useCallback(
    (conversationId: string): Promise<boolean> => {
      if (!messagingDeps) return Promise.resolve(false);
      return messagingDeps.keystore.hasConversationState(messagingDeps.device, conversationId);
    },
    [messagingDeps],
  );

  const handleOpenExisting = (conversationId: string): void => {
    setSelectedId(conversationId);
    setStartOpen(false);
    setStartPrefillArgusId(undefined);
  };

  const handleStarted = useCallback(
    (
      session: Parameters<typeof persistStartedConversation>[0],
      peer: Parameters<typeof persistStartedConversation>[1],
    ) => {
      persistStartedConversation(session, peer);
      setSelectedId(session.conversationId);
      setStartOpen(false);
      setStartPrefillArgusId(undefined);
      if (window.innerWidth < 1024) setShowSidebar(false);
    },
    [persistStartedConversation],
  );

  const handleOpenAddMember = (): void => {
    if (!selectedId) return;
    if (!liveGroups.current.has(selectedId)) return;
    setAddMemberOpen(true);
  };

  return (
    <div className="relative flex h-full bg-[#1a1a24] sm:items-center sm:justify-center sm:p-4">
      <div
        className={`absolute inset-0 w-full sm:static sm:h-[calc(100%-2rem)] sm:max-w-6xl bg-[#12121a] sm:rounded-3xl overflow-hidden flex shadow-2xl shadow-black/50 transition-all duration-700 ease-out ${
          mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
        }`}
      >
        {/* Sidebar */}
        <aside
          aria-label="Conversations"
          onWheelCapture={handleSidebarWheelCapture}
          onTouchStartCapture={handleSidebarTouchStartCapture}
          onTouchMoveCapture={handleSidebarTouchMoveCapture}
          onTouchEndCapture={handleSidebarTouchEndCapture}
          className={`${
            showSidebar && !mobileThreadClosing ? 'flex' : 'hidden lg:flex'
          } w-full lg:w-80 shrink-0 flex-col bg-[#0f0f16] border-r border-white/5 transition-all duration-500 ${
            mounted ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-8'
          } ${mobileSidebarReturning ? paneBackEnterMotion : ''}`}
        >
          <div className="relative bg-[#0f0f16]/80 backdrop-blur-xl p-4 pt-[env(safe-area-inset-top)] sm:pt-4 after:pointer-events-none after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-inherit after:backdrop-blur-xl after:content-['']">
            <div className="flex items-center gap-2">
              <ArgusAppIcon className="h-8 w-8 rounded-lg shadow-sm shadow-[#964cdc]/25" />
              <span className="flex-1 text-center text-xl font-bold tracking-wider">
                <span className="bg-gradient-to-r from-[var(--argus-brand-400)] to-[var(--argus-brand-600)] bg-clip-text text-transparent">
                  CHAT
                </span>
              </span>
            </div>

            {/* Search input — slides in when open */}
            <div
              id="chat-search-panel"
              onWheel={handleSearchWheel}
              onTouchStart={handleSearchTouchStart}
              onTouchMove={handleSearchTouchMove}
              onTouchEnd={handleSearchTouchEnd}
              className={`overflow-hidden transition-all duration-300 ease-out ${
                searchOpen ? 'mt-3 max-h-20 opacity-100' : 'pointer-events-none max-h-0 opacity-0'
              }`}
              aria-hidden={!searchOpen}
            >
              <div className="relative">
                <Search
                  aria-hidden="true"
                  className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30"
                />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onWheel={handleSearchWheel}
                  onTouchStart={handleSearchTouchStart}
                  onTouchMove={handleSearchTouchMove}
                  onTouchEnd={handleSearchTouchEnd}
                  onFocus={() => {
                    setSearchFocused(true);
                    revealSearch();
                  }}
                  onBlur={() => setSearchFocused(false)}
                  aria-label="Search conversations"
                  placeholder="Search conversations..."
                  ref={searchInputRef}
                  tabIndex={searchOpen ? undefined : -1}
                  className="w-full rounded-xl border border-white/5 bg-[#1a1a26] py-2.5 pl-10 pr-9 text-sm text-white placeholder-white/30 transition-colors focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/20"
                />
                <button
                  type="button"
                  tabIndex={searchOpen ? undefined : -1}
                  onClick={hideSearch}
                  aria-label="Close search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Pill handle — tap to reveal search */}
            <div
              aria-hidden={searchOpen}
              className={`overflow-hidden transition-all duration-300 ${
                searchOpen ? 'max-h-0 py-0 opacity-0' : 'max-h-9 py-1 opacity-100'
              }`}
            >
              <button
                type="button"
                onClick={focusSearch}
                aria-label="Reveal conversation search"
                aria-expanded={searchOpen}
                aria-controls="chat-search-panel"
                tabIndex={searchOpen ? -1 : 0}
                className="group mx-auto flex h-7 w-12 items-center justify-center rounded-full transition-colors hover:bg-white/[0.03]"
              >
                <span className="block h-1 w-10 rounded-full bg-white/15 transition-colors group-hover:bg-white/25" />
              </button>
            </div>
          </div>

          <div
            ref={listRef}
            onWheel={handleListWheel}
            onScroll={hideSearchIfIdle}
            onTouchStart={handleListTouchStart}
            onTouchMove={handleListTouchMove}
            onTouchEnd={handleListTouchEnd}
            className="flex-1 min-h-0 overflow-y-auto"
          >
            <ConversationList
              conversations={filteredConversations}
              selectedId={selectedId}
              onSelect={handleSelect}
              mutedConversationIds={mutedConversationIds}
            />
          </div>
        </aside>

        {/* Main */}
        <div
          ref={mainPanelRef}
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
                  liveGroups.current.has(selectedConversation.id) &&
                  !selectedIsSyncLost
                    ? handleOpenAddMember
                    : undefined
                }
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
              <MessageList
                conversation={selectedConversation}
                onImageClick={setPreviewImage}
                bottomNavClearance={false}
              />
              {effectiveSelectedIsLive && !selectedIsSyncLost && (
                <ChatInput
                  onSend={handleSend}
                  disabled={!peerIsFriend}
                  disabledNotice="You are no longer friends with this person. Re-add them as a friend to send messages."
                />
              )}
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
      {startOpen && manager && (
        <StartConversation
          manager={manager}
          selfUserId={profile?.userId}
          existingConversationWith={findConversationWith}
          onOpenExisting={handleOpenExisting}
          onStarted={handleStarted}
          prefillArgusId={startPrefillArgusId}
          conversationHasState={conversationHasState}
          onClose={() => {
            setStartOpen(false);
            setStartPrefillArgusId(undefined);
          }}
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
            if (v && selectedId) setPeerKeyChangedConvId(null);
            if (selectedId && messagingDeps) {
              const { device, keystore, sessionKey } = messagingDeps;
              const peerUserId = loadPersistedPeerMapping(selectedId);
              if (peerUserId) {
                if (!v) {
                  void keystore.deleteVerifiedPeer(peerUserId);
                } else {
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
          onClose={() => setVerifyOpen(false)}
        />
      )}
    </div>
  );
}
