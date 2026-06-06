import { ChevronDown, Plus, Search, Settings } from 'lucide-react';
import type { Conversation } from './types';
import { ME, conversationTitle, lastMessage, otherParticipant } from './types';
import { Avatar } from './Avatar';
import { formatRelativeTime } from './format';

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSettings?: () => void;
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onSettings,
}: ConversationListProps) {
  return (
    <div className="flex h-full flex-col">
      {/* Profile */}
      <div className="border-b border-white/5 p-4">
        <button
          type="button"
          onClick={onSettings}
          className="flex w-full items-center gap-3 rounded-xl p-2 transition-colors hover:bg-[#1a1a26]"
        >
          <Avatar name="You" size={40} online />
          <div className="min-w-0 flex-1 text-left">
            <p className="truncate text-sm font-medium text-white">You</p>
            <p className="truncate text-xs text-white/40">Online</p>
          </div>
          <span className="rounded-lg p-1.5 text-white/40">
            <Settings className="h-4 w-4" />
          </span>
          <ChevronDown className="h-4 w-4 text-white/40" />
        </button>
      </div>

      {/* New conversation */}
      <div className="px-4 pb-2 pt-4">
        <button
          type="button"
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-purple-500 py-2.5 text-sm font-medium text-white shadow-lg shadow-purple-500/25 transition-all hover:-translate-y-0.5 hover:bg-purple-400 hover:shadow-purple-500/40 active:translate-y-0"
        >
          <Plus className="h-4 w-4" /> New Conversation
        </button>
      </div>

      {/* Search */}
      <div className="p-4 pt-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
          <input
            type="text"
            placeholder="Search conversations..."
            className="w-full rounded-xl border border-white/5 bg-[#1a1a26] py-2.5 pl-10 pr-4 text-sm text-white placeholder-white/30 transition-all focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/20"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {conversations.map((c) => {
          const title = conversationTitle(c);
          const last = lastMessage(c);
          const other = otherParticipant(c);
          const selected = selectedId === c.id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect(c.id)}
              className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-all ${
                selected
                  ? 'border-purple-500/30 bg-purple-500/20'
                  : 'border-transparent hover:bg-[#1a1a26]'
              }`}
            >
              <Avatar
                name={title}
                size={48}
                online={c.kind === 'direct' && other?.online}
                group={c.kind === 'group'}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`truncate font-medium ${selected ? 'text-white' : 'text-white/90'}`}
                  >
                    {title}
                  </span>
                  {last && (
                    <span className="shrink-0 text-xs text-white/40">
                      {formatRelativeTime(last.sentAt)}
                    </span>
                  )}
                </div>
                {last && (
                  <div className="mt-0.5 flex items-center gap-2">
                    <p className="truncate text-sm text-white/50">
                      {last.senderId === ME && <span className="text-white/30">You: </span>}
                      {last.images?.length ? 'Sent an image' : last.body}
                    </p>
                    {c.unread > 0 && (
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-purple-500 text-xs font-medium text-white">
                        {c.unread}
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
