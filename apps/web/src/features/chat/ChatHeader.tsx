import { Phone, Video, MoreVertical, ArrowLeft, Users } from 'lucide-react';
import type { Conversation } from './seed';
import {
  currentUser,
  getConversationDisplayName,
  getConversationAvatar,
  getOtherParticipant,
} from './seed';

interface ChatHeaderProps {
  conversation: Conversation;
  onBack?: () => void;
}

export function ChatHeader({ conversation, onBack }: ChatHeaderProps) {
  const displayName = getConversationDisplayName(conversation, currentUser.id);
  const avatar = getConversationAvatar(conversation, currentUser.id);
  const otherUser = getOtherParticipant(conversation, currentUser.id);
  const isOnline = conversation.type === 'direct' && otherUser?.isOnline;

  const statusText =
    conversation.type === 'group'
      ? `${conversation.participants.length} members`
      : isOnline
        ? 'Online'
        : 'Offline';

  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-[#0f0f16]">
      <div className="flex items-center gap-3">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="lg:hidden p-2 -ml-2 rounded-xl text-white/60 hover:text-white hover:bg-[#1a1a26] transition-all duration-300"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
        )}

        <div className="relative">
          <div className="w-10 h-10 rounded-full overflow-hidden ring-2 ring-white/5">
            <img src={avatar} alt={displayName} className="object-cover w-full h-full" />
          </div>
          {isOnline && (
            <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full ring-2 ring-[#0f0f16]" />
          )}
          {conversation.type === 'group' && (
            <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-purple-500 rounded-full flex items-center justify-center ring-2 ring-[#0f0f16]">
              <Users className="w-2.5 h-2.5 text-white" />
            </div>
          )}
        </div>

        <div>
          <h2 className="font-semibold text-white">{displayName}</h2>
          <p className={`text-xs ${isOnline ? 'text-green-400' : 'text-white/40'}`}>{statusText}</p>
        </div>
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          className="p-2.5 rounded-xl text-white/40 hover:text-white/70 hover:bg-[#1a1a26] transition-all duration-300"
        >
          <Phone className="w-5 h-5" />
        </button>
        <button
          type="button"
          className="p-2.5 rounded-xl text-white/40 hover:text-white/70 hover:bg-[#1a1a26] transition-all duration-300"
        >
          <Video className="w-5 h-5" />
        </button>
        <button
          type="button"
          className="p-2.5 rounded-xl text-white/40 hover:text-white/70 hover:bg-[#1a1a26] transition-all duration-300"
        >
          <MoreVertical className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
