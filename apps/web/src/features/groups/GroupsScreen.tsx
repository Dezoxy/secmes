import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Unplug, Users, X } from 'lucide-react';
import { prefersReducedMotion } from '../../lib/pref';
import { demoMode } from '../../lib/auth';
import { ArgusAppIcon } from '../brand/ArgusAppIcon';
import { ConversationList } from '../chat/ConversationList';
import { ChatHeader } from '../chat/ChatHeader';
import { MessageList } from '../chat/MessageList';
import { ChatInput } from '../chat/ChatInput';
import { GroupCreateDialog } from '../chat/GroupCreateDialog';
import { ImagePreviewModal } from '../chat/ImagePreviewModal';
import { contactDisplayName } from '../chat/user-label';
import { dicebearAvatar } from '../../lib/dicebear';
import { currentUser, getConversationDisplayName } from '../chat/seed';
import { useSelectedConversationBackfill } from '../chat/useConversationBackfill';
import { useChatState } from '../chat/useChatState';
import { useMessageSending } from '../chat/useMessageSending';
import { useReceiptSending } from '../chat/useReceiptSending';
import { useChatContext } from '../chat/ChatContext';
import { useSetNavVisible } from '../../routes/NavVisibilityContext';
import { tabSelectedId } from '../chat/tabSelectedId';
import {
  ReconnectBanner,
  StateBlock,
  conversationEnterMotion,
  paneBackEnterMotion,
  paneBackExitMotion,
} from '../ui';

export default function GroupsScreen() {
  const setNavVisible = useSetNavVisible();
  const {
    conversations,
    setConversations,
    groupManager,
    messagingDeps,
    liveIds,
    liveGroups,
    connectionStatus,
    appendHistory,
    backfillInto,
    serverProfile: profile,
    numbersByConv,
    verifiedByConv,
    persistGroupCreated,
  } = useChatContext();

  const groupConversations = conversations.filter((c) => c.type === 'group');

  const [selectedId, setSelectedId] = useState<string | null>(tabSelectedId.get('/groups') ?? null);
  useEffect(() => {
    tabSelectedId.set('/groups', selectedId);
  }, [selectedId]);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [mobileThreadClosing, setMobileThreadClosing] = useState(false);
  const [mobileSidebarReturning, setMobileSidebarReturning] = useState(false);
  const [groupCreateOpen, setGroupCreateOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const mobileThreadBackTimerRef = useRef<number | undefined>(undefined);
  const mobileSidebarReturnTimerRef = useRef<number | undefined>(undefined);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef<number | null>(null);
  const sidebarTouchStartY = useRef<number | null>(null);
  const searchTouchStartY = useRef<number | null>(null);

  const { selectedConversation, selectedIsLive, isLive } = useChatState({
    conversations: groupConversations,
    selectedId,
    liveIds,
    numbersByConv,
    verifiedByConv,
  });

  const effectiveSelectedIsLive = demoMode ? !!selectedId : selectedIsLive;
  const selectedIsSyncLost = selectedConversation?.recovery === 'sync-lost';

  const handleSend = useMessageSending({
    selectedId,
    isLive,
    liveGroups,
    messagingDeps,
    appendHistory,
    setConversations,
  });

  // Read receipts only — delivered receipts are handled globally by ChatProvider.
  useReceiptSending({ conversations, liveIds, selectedId, selectedIsLive, sendDelivered: false });

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
    return () => {
      if (mobileThreadBackTimerRef.current !== undefined)
        window.clearTimeout(mobileThreadBackTimerRef.current);
      if (mobileSidebarReturnTimerRef.current !== undefined)
        window.clearTimeout(mobileSidebarReturnTimerRef.current);
    };
  }, []);

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

  const handleBackToConversations = () => {
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
  };

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

  const filteredGroupConversations = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return groupConversations;
    return groupConversations.filter((c) =>
      getConversationDisplayName(c, currentUser.id).toLowerCase().includes(q),
    );
  }, [groupConversations, searchQuery]);

  return (
    <div className="relative flex h-full bg-[#1a1a24] sm:items-center sm:justify-center sm:p-4">
      <div
        className="absolute inset-0 w-full sm:static sm:h-[calc(100%-2rem)] sm:max-w-6xl bg-[#12121a] sm:rounded-3xl overflow-hidden flex shadow-2xl shadow-black/50"
      >
        {/* Sidebar */}
        <aside
          aria-label="Group conversations"
          onWheelCapture={handleSidebarWheelCapture}
          onTouchStartCapture={handleSidebarTouchStartCapture}
          onTouchMoveCapture={handleSidebarTouchMoveCapture}
          onTouchEndCapture={handleSidebarTouchEndCapture}
          className={`${
            showSidebar && !mobileThreadClosing ? 'flex' : 'hidden lg:flex'
          } relative w-full lg:w-80 shrink-0 flex-col bg-[#0f0f16] border-r border-white/5 ${mobileSidebarReturning ? paneBackEnterMotion : ''}`}
        >
          <div className="relative bg-[#0f0f16]/80 backdrop-blur-xl p-4 pt-[env(safe-area-inset-top)] sm:pt-4 after:pointer-events-none after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-inherit after:backdrop-blur-xl after:content-['']">
            <div className="flex items-center gap-2">
              <ArgusAppIcon className="h-8 w-8 rounded-lg shadow-sm shadow-[#964cdc]/25" />
              <span className="flex-1 text-center text-xl font-bold tracking-wider">
                <span className="bg-gradient-to-r from-[var(--argus-brand-400)] to-[var(--argus-brand-600)] bg-clip-text text-transparent">
                  GROUPS
                </span>
              </span>
              {groupManager && messagingDeps ? (
                <button
                  type="button"
                  onClick={() => setGroupCreateOpen(true)}
                  className="flex shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] p-2 text-white/70 transition-colors hover:border-purple-500/30 hover:bg-purple-500/10 hover:text-purple-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                  aria-label="Create new group"
                >
                  <Users className="h-4 w-4" />
                </button>
              ) : (
                <div className="h-8 w-8 shrink-0" aria-hidden="true" />
              )}
            </div>

            {/* Search input — slides in when open */}
            <div
              id="groups-search-panel"
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
                  aria-label="Search groups"
                  placeholder="Search groups..."
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
                aria-label="Reveal group search"
                aria-expanded={searchOpen}
                aria-controls="groups-search-panel"
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
              conversations={filteredGroupConversations}
              selectedId={selectedId}
              onSelect={handleSelect}
            />
          </div>
        </aside>

        {/* Main */}
        <div
          role="main"
          aria-label="Group chat"
          className={`${
            !showSidebar || mobileThreadClosing ? 'flex' : 'hidden lg:flex'
          } flex-1 flex-col ${mobileThreadClosing ? paneBackExitMotion : ''}`}
        >
          {selectedConversation ? (
            <div
              key={selectedConversation.id}
              className={`flex min-h-0 flex-1 flex-col ${conversationEnterMotion}`}
            >
              <ChatHeader
                conversation={selectedConversation}
                onBack={handleBackToConversations}
                verified={false}
                onVerify={undefined}
                onAddMember={
                  selectedConversation.creatorId === profile?.userId &&
                  liveGroups.current.has(selectedConversation.id) &&
                  !selectedIsSyncLost
                    ? () => setAddMemberOpen(true)
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
              {effectiveSelectedIsLive && !selectedIsSyncLost && <ChatInput onSend={handleSend} />}
            </div>
          ) : (
            <div
              key="empty-group"
              className={`flex flex-1 flex-col items-center justify-center p-8 text-center ${conversationEnterMotion}`}
            >
              <div className="w-20 h-20 bg-purple-500/20 rounded-full flex items-center justify-center mb-4">
                <Users className="w-10 h-10 text-purple-400" />
              </div>
              <h2 className="text-xl font-semibold text-white mb-2">Group chats</h2>
              <p className="text-white/60 max-w-sm">
                {groupManager
                  ? 'Select a group or tap "New group" to create one'
                  : 'Select a group conversation to start messaging'}
              </p>
            </div>
          )}
        </div>
      </div>

      <ImagePreviewModal imageUrl={previewImage} onClose={() => setPreviewImage(null)} />

      {groupCreateOpen && groupManager && messagingDeps && (
        <GroupCreateDialog
          mode="create"
          manager={groupManager}
          deps={messagingDeps}
          selfUserId={profile?.userId}
          onCreated={(session) => {
            persistGroupCreated(session);
            setSelectedId(session.conversationId);
            setGroupCreateOpen(false);
            if (window.innerWidth < 1024) setShowSidebar(false);
          }}
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
    </div>
  );
}
