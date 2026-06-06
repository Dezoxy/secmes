import { useEffect, useRef } from 'react';
import type { Conversation } from './types';
import { ME } from './types';
import { MessageBubble } from './MessageBubble';

interface MessageListProps {
  conversation: Conversation;
  onImageClick?: (src: string) => void;
}

export function MessageList({ conversation, onImageClick }: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const isGroup = conversation.kind === 'group';

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conversation.id, conversation.messages.length]);

  return (
    <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
      {conversation.messages.map((msg, i) => {
        const prev = conversation.messages[i - 1];
        const showSender = isGroup && msg.senderId !== ME && msg.senderId !== prev?.senderId;
        const sender = conversation.participants.find((p) => p.id === msg.senderId);
        return (
          <MessageBubble
            key={msg.id}
            message={msg}
            sender={sender}
            showSender={showSender}
            onImageClick={onImageClick}
          />
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
