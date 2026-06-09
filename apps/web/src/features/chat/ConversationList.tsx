import { useRef, useState } from 'react';
import { Search, Plus, Users, Settings } from 'lucide-react';
import type { Conversation, User } from './seed';
import {
  currentUser,
  getConversationDisplayName,
  getConversationAvatar,
  getOtherParticipant,
  formatMessageTime,
} from './seed';
import { Avatar, Button, EmptyState } from '../ui';

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  currentUserProfile?: User;
  /** Opens account settings. */
  onSettings?: () => void;
  /** Starts the claim → verify → create flow. Absent in demo mode (no unlocked device) → button hidden. */
  onNewConversation?: () => void;
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  currentUserProfile = currentUser,
  onSettings,
  onNewConversation,
}: ConversationListProps) {
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const touchStartY = useRef<number | null>(null);

  const revealSearch = () => setSearchVisible(true);

  const hideSearchIfIdle = () => {
    if (!searchFocused) setSearchVisible(false);
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const scrollTop = listRef.current?.scrollTop ?? 0;
    if (event.deltaY < -12 && scrollTop <= 2) revealSearch();
    if (event.deltaY > 12 && scrollTop > 12) hideSearchIfIdle();
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if ((listRef.current?.scrollTop ?? 0) <= 2) {
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
  };

  const handleTouchEnd = () => {
    touchStartY.current = null;
  };

  const focusSearch = () => {
    revealSearch();
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  };

  return (
    <div className="flex flex-col h-full">
      {/* User Profile Section */}
      <div className="p-4 border-b border-white/5">
        <button
          type="button"
          onClick={onSettings}
          aria-label="Open settings"
          className="w-full flex items-center gap-3 p-2 rounded-xl hover:bg-[#1a1a26] transition-all duration-300 group"
        >
          <div className="relative shrink-0">
            <Avatar
              src={currentUserProfile.avatar}
              name={currentUserProfile.name}
              size="md"
              shape="circle"
              className="ring-2 ring-purple-500/50"
            />
            <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full ring-2 ring-[#12121a]" />
          </div>
          <div className="flex-1 min-w-0 text-left">
            <p className="text-white font-medium text-sm truncate">{currentUserProfile.name}</p>
            <p className="text-white/40 text-xs truncate">Online</p>
          </div>
          <div className="flex items-center gap-1">
            <span className="p-1.5 rounded-lg text-white/40 group-hover:text-white/80 transition-all duration-300">
              <Settings className="w-4 h-4" />
            </span>
          </div>
        </button>
      </div>

      {/* New Conversation */}
      {onNewConversation && (
        <div className="px-4 pt-4 pb-2">
          <Button
            onClick={onNewConversation}
            size="lg"
            className="w-full shadow-purple-500/25 hover:-translate-y-0.5 hover:shadow-purple-500/40 active:translate-y-0"
          >
            <Plus className="w-4 h-4" />
            New Conversation
          </Button>
        </div>
      )}

      {/* Pull-down Search */}
      <div
        className={`overflow-hidden transition-all duration-300 ease-out ${
          searchVisible
            ? 'max-h-20 translate-y-0 opacity-100'
            : 'pointer-events-none max-h-0 -translate-y-2 opacity-0'
        }`}
        aria-hidden={!searchVisible}
      >
        <div className="px-4 pb-3 pt-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search conversations..."
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
          searchVisible ? 'max-h-0 py-0 opacity-0' : 'max-h-5 py-2 opacity-100'
        }`}
      >
        <button
          type="button"
          onClick={focusSearch}
          className="mx-auto block h-1 w-10 rounded-full bg-white/10 transition-all duration-300 hover:bg-white/20"
          aria-label="Reveal conversation search"
        />
      </div>

      {/* List */}
      <div
        ref={listRef}
        onWheel={handleWheel}
        onScroll={hideSearchIfIdle}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className="flex-1 overflow-y-auto px-2 space-y-1"
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

          return (
            <button
              type="button"
              key={conversation.id}
              onClick={() => onSelect(conversation.id)}
              className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all duration-300 group ${
                isSelected
                  ? 'bg-purple-500/20 border border-purple-500/30'
                  : 'hover:bg-[#1a1a26] border border-transparent'
              }`}
            >
              <div className="relative shrink-0">
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
                    <span className="text-xs text-white/40 shrink-0">
                      {formatMessageTime(lastMessage.timestamp)}
                    </span>
                  )}
                </div>
                {lastMessage && (
                  <div className="flex items-center gap-2 mt-0.5">
                    <p className="text-sm text-white/50 truncate">
                      {lastMessage.senderId === currentUser.id && (
                        <span className="text-white/30">You: </span>
                      )}
                      {lastMessage.attachments?.length
                        ? `Sent ${lastMessage.attachments[0]?.type === 'image' ? 'an image' : 'a file'}`
                        : lastMessage.content}
                    </p>
                    {conversation.unreadCount > 0 && (
                      <span className="shrink-0 w-5 h-5 bg-purple-500 rounded-full text-xs font-medium text-white flex items-center justify-center">
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
    </div>
  );
}
