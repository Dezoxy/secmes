import { Users } from 'lucide-react';
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
  /** Replaces the default bottom padding on the scrollable list. Pass a Tailwind `pb-` class when an absolutely-positioned element (e.g. a FAB) overlaps the list bottom. */
  listPb?: string;
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  mutedConversationIds,
  listPb,
}: ConversationListProps) {
  return (
    <div
      className={`flex-1 overflow-y-auto px-2 space-y-1 ${listPb ?? 'pb-[calc(env(safe-area-inset-bottom)_+_6rem)] lg:pb-[calc(env(safe-area-inset-bottom)_+_0.75rem)]'}`}
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
  );
}
