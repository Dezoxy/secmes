import { ArrowLeft, MoreVertical, Phone, Video } from 'lucide-react';
import type { Conversation } from './types';
import { conversationTitle, otherParticipant } from './types';
import { Avatar } from './Avatar';

interface ChatHeaderProps {
  conversation: Conversation;
  onBack?: () => void;
}

export function ChatHeader({ conversation, onBack }: ChatHeaderProps) {
  const isGroup = conversation.kind === 'group';
  const title = conversationTitle(conversation);
  const other = otherParticipant(conversation);
  const subtitle = isGroup
    ? `${conversation.participants.length} members`
    : other?.online
      ? 'Online'
      : 'Offline';

  return (
    <div className="flex items-center gap-3 border-b border-white/5 px-4 py-3">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg p-1.5 text-white/50 hover:bg-white/5 hover:text-white/80 lg:hidden"
          aria-label="Back to conversations"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
      )}
      <Avatar name={title} size={40} online={!isGroup && other?.online} group={isGroup} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-white">{title}</p>
        <p className="truncate text-xs text-white/40">{subtitle}</p>
      </div>
      <div className="flex items-center gap-1 text-white/40">
        <button
          type="button"
          className="rounded-lg p-2 transition-colors hover:bg-white/5 hover:text-white/70"
          aria-label="Voice call"
        >
          <Phone className="h-5 w-5" />
        </button>
        <button
          type="button"
          className="rounded-lg p-2 transition-colors hover:bg-white/5 hover:text-white/70"
          aria-label="Video call"
        >
          <Video className="h-5 w-5" />
        </button>
        <button
          type="button"
          className="rounded-lg p-2 transition-colors hover:bg-white/5 hover:text-white/70"
          aria-label="Conversation options"
        >
          <MoreVertical className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
