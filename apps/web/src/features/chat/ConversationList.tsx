import { Search, Plus, Users, Settings, ChevronDown } from 'lucide-react';
import type { Conversation } from './seed';
import {
  currentUser,
  getConversationDisplayName,
  getConversationAvatar,
  getOtherParticipant,
  formatMessageTime,
} from './seed';

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Opens the account / key-recovery panel (the settings button in the profile row). */
  onSettings?: () => void;
  /** Starts the claim → verify → create flow. Absent in demo mode (no unlocked device) → button hidden. */
  onNewConversation?: () => void;
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onSettings,
  onNewConversation,
}: ConversationListProps) {
  return (
    <div className="flex flex-col h-full">
      {/* User Profile Section */}
      <div className="p-4 border-b border-white/5">
        <button
          type="button"
          onClick={onSettings}
          className="w-full flex items-center gap-3 p-2 rounded-xl hover:bg-[#1a1a26] transition-all duration-300 group"
        >
          <div className="relative shrink-0">
            <div className="w-10 h-10 rounded-full overflow-hidden ring-2 ring-purple-500/50">
              <img
                src={currentUser.avatar}
                alt={currentUser.name}
                className="object-cover w-full h-full"
              />
            </div>
            <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full ring-2 ring-[#12121a]" />
          </div>
          <div className="flex-1 min-w-0 text-left">
            <p className="text-white font-medium text-sm truncate">{currentUser.name}</p>
            <p className="text-white/40 text-xs truncate">Online</p>
          </div>
          <div className="flex items-center gap-1">
            <span className="p-1.5 rounded-lg text-white/40 group-hover:text-white/80 transition-all duration-300">
              <Settings className="w-4 h-4" />
            </span>
            <ChevronDown className="w-4 h-4 text-white/40 group-hover:text-white/60 transition-colors duration-300" />
          </div>
        </button>
      </div>

      {/* New Conversation */}
      {onNewConversation && (
        <div className="px-4 pt-4 pb-2">
          <button
            type="button"
            onClick={onNewConversation}
            className="w-full flex items-center justify-center gap-2 bg-purple-500 hover:bg-purple-400 text-white font-medium py-2.5 rounded-xl transition-all duration-300 text-sm shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40 hover:-translate-y-0.5 active:translate-y-0"
          >
            <Plus className="w-4 h-4" />
            New Conversation
          </button>
        </div>
      )}

      {/* Search */}
      <div className="p-4 pt-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
          <input
            type="text"
            placeholder="Search conversations..."
            className="w-full bg-[#1a1a26] border border-white/5 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-white/30 focus:outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/20 transition-all duration-300"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-2 space-y-1">
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
                <div className="w-12 h-12 rounded-full overflow-hidden ring-2 ring-white/5">
                  <img src={avatar} alt={displayName} className="object-cover w-full h-full" />
                </div>
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
