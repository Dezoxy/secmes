import { useRef, useState } from 'react';
import { Search, Users, RefreshCw } from 'lucide-react';
import type { Conversation } from './seed';
import {
  currentUser,
  getConversationDisplayName,
  getConversationAvatar,
  getOtherParticipant,
  formatMessageTime,
} from './seed';
import { Avatar, EmptyState } from '../ui';

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Conversation IDs with in-app notification badges suppressed. */
  mutedConversationIds?: ReadonlySet<string>;
  updateReady?: boolean;
  onApplyUpdate?: () => void | Promise<void>;
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  mutedConversationIds,
  updateReady = false,
  onApplyUpdate,
}: ConversationListProps) {
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const touchStartY = useRef<number | null>(null);
  const searchTouchStartY = useRef<number | null>(null);
  const sidebarTouchStartY = useRef<number | null>(null);

  const revealSearch = () => setSearchVisible(true);

  const hideSearch = () => {
    searchInputRef.current?.blur();
    setSearchFocused(false);
    setSearchVisible(false);
  };

  const hideSearchIfIdle = () => {
    if (!searchFocused) setSearchVisible(false);
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const scrollTop = listRef.current?.scrollTop ?? 0;
    if (event.deltaY < -12 && scrollTop <= 2) revealSearch();
    if (event.deltaY > 12) {
      if (searchVisible) hideSearch();
      else if (scrollTop > 12) hideSearchIfIdle();
    }
  };

  const handleSidebarWheelCapture = (event: React.WheelEvent<HTMLDivElement>) => {
    if (searchVisible && event.deltaY > 12) hideSearch();
  };

  const handleSidebarTouchStartCapture = (event: React.TouchEvent<HTMLDivElement>) => {
    if (searchVisible) sidebarTouchStartY.current = event.touches[0]?.clientY ?? null;
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

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (searchVisible || (listRef.current?.scrollTop ?? 0) <= 2) {
      touchStartY.current = event.touches[0]?.clientY ?? null;
    }
  };

  const handleTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const startY = touchStartY.current;
    const currentY = event.touches[0]?.clientY;
    if (startY === null || currentY === undefined) return;
    if (currentY - startY > 28 && (listRef.current?.scrollTop ?? 0) <= 2) {
      revealSearch();
    }
    if (currentY - startY < -28 && searchVisible) {
      hideSearch();
    }
  };

  const handleTouchEnd = () => {
    touchStartY.current = null;
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

  const focusSearch = () => {
    revealSearch();
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  };

  return (
    <div
      className="flex h-full flex-col"
      onWheelCapture={handleSidebarWheelCapture}
      onTouchStartCapture={handleSidebarTouchStartCapture}
      onTouchMoveCapture={handleSidebarTouchMoveCapture}
      onTouchEndCapture={handleSidebarTouchEndCapture}
    >
      {/* Pull-down Search */}
      <div
        onWheel={handleSearchWheel}
        onTouchStart={handleSearchTouchStart}
        onTouchMove={handleSearchTouchMove}
        onTouchEnd={handleSearchTouchEnd}
        className={`overflow-hidden transition-all duration-300 ease-out ${
          searchVisible
            ? 'max-h-20 translate-y-0 opacity-100'
            : 'pointer-events-none max-h-0 -translate-y-2 opacity-0'
        }`}
        aria-hidden={!searchVisible}
      >
        <div className="px-4 pb-3 pt-2">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30"
            />
            <input
              ref={searchInputRef}
              type="text"
              aria-label="Search conversations"
              tabIndex={searchVisible ? undefined : -1}
              placeholder="Search conversations..."
              onWheel={handleSearchWheel}
              onTouchStart={handleSearchTouchStart}
              onTouchMove={handleSearchTouchMove}
              onTouchEnd={handleSearchTouchEnd}
              onFocus={() => {
                setSearchFocused(true);
                revealSearch();
              }}
              onBlur={() => setSearchFocused(false)}
              className="w-full rounded-xl border border-white/5 bg-[#1a1a26] py-2.5 pl-10 pr-4 text-sm text-white placeholder-white/30 transition-all duration-300 focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/20"
            />
          </div>
        </div>
      </div>

      <div
        className={`overflow-hidden px-4 transition-all duration-300 ${
          searchVisible ? 'max-h-0 py-0 opacity-0' : 'max-h-9 py-1 opacity-100'
        }`}
      >
        <button
          type="button"
          onClick={focusSearch}
          className="group mx-auto flex h-7 w-12 items-center justify-center rounded-full transition-colors duration-300 hover:bg-white/[0.03]"
          aria-label="Reveal conversation search"
        >
          <span className="block h-1 w-10 rounded-full bg-white/15 transition-colors duration-300 group-hover:bg-white/25" />
        </button>
      </div>

      {/* Conversation list */}
      <div
        ref={listRef}
        onWheel={handleWheel}
        onScroll={hideSearchIfIdle}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className="flex-1 overflow-y-auto px-2 pb-[calc(env(safe-area-inset-bottom)_+_0.75rem)] space-y-1"
      >
        {conversations.length === 0 && (
          <EmptyState title="No conversations yet" icon={Users} compact className="mx-2 mt-4">
            Start a secure conversation when another member is available.
          </EmptyState>
        )}

        {conversations.map((conversation) => {
          const displayName = getConversationDisplayName(conversation, currentUser.id);
          const avatar = getConversationAvatar(conversation, currentUser.id);
          const otherUser = getOtherParticipant(conversation, currentUser.id);
          const lastMessage = conversation.messages[conversation.messages.length - 1];
          const isSelected = selectedId === conversation.id;
          const isOnline = conversation.type === 'direct' && otherUser?.isOnline;
          const isMuted = mutedConversationIds?.has(conversation.id) ?? false;

          return (
            <button
              type="button"
              key={conversation.id}
              onClick={() => onSelect(conversation.id)}
              aria-pressed={isSelected}
              className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all duration-300 group ${
                isSelected
                  ? 'bg-purple-500/20 border border-purple-500/30'
                  : 'hover:bg-[#1a1a26] border border-transparent'
              }`}
            >
              <span className="sr-only">Open conversation with</span>
              <div className="relative shrink-0" aria-hidden="true">
                <Avatar
                  src={avatar}
                  name={displayName}
                  size="lg"
                  shape="circle"
                  className="ring-2 ring-white/5"
                />
                {isOnline && (
                  <div className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-green-500 rounded-full ring-2 ring-[#12121a]" />
                )}
                {conversation.type === 'group' && (
                  <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-purple-500 rounded-full flex items-center justify-center ring-2 ring-[#12121a]">
                    <Users className="w-3 h-3 text-white" />
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-0 text-left">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`font-medium truncate ${isSelected ? 'text-white' : 'text-white/90'}`}
                  >
                    {displayName}
                  </span>
                  {lastMessage && (
                    <span className="text-xs text-white/55 shrink-0">
                      {formatMessageTime(lastMessage.timestamp)}
                    </span>
                  )}
                </div>
                {lastMessage && (
                  <div className="flex items-center gap-2 mt-0.5">
                    <p className="text-sm text-white/60 truncate">
                      {lastMessage.senderId === currentUser.id && (
                        <span className="text-white/60">You: </span>
                      )}
                      {lastMessage.attachments?.length
                        ? `Sent ${lastMessage.attachments[0]?.type === 'image' ? 'an image' : 'a file'}`
                        : lastMessage.content}
                    </p>
                    {conversation.unreadCount > 0 && !isMuted && (
                      <span
                        aria-label={`${conversation.unreadCount} unread`}
                        className="shrink-0 w-5 h-5 bg-purple-500 rounded-full text-xs font-medium text-white flex items-center justify-center"
                      >
                        {conversation.unreadCount}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {updateReady && onApplyUpdate && (
        <div
          className="relative shrink-0 bg-[#0f0f16] px-4 pb-4 pt-3 before:absolute before:left-0 before:right-[-1px] before:top-0 before:h-px before:bg-white/5"
          role="status"
          aria-live="polite"
        >
          <button
            type="button"
            onClick={() => void onApplyUpdate()}
            aria-label="Update Argus"
            className="mx-auto flex h-9 items-center gap-2 rounded-full border border-purple-400/30 bg-purple-500/15 px-4 text-sm font-semibold text-purple-100 shadow-lg shadow-purple-950/25 transition-all duration-300 hover:-translate-y-0.5 hover:border-purple-300/50 hover:bg-purple-500/25 active:translate-y-0"
          >
            <RefreshCw className="h-4 w-4" />
            Update
          </button>
        </div>
      )}
    </div>
  );
}
