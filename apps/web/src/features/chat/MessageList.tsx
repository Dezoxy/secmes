import { useEffect, useRef } from 'react';
import { MessageBubble } from './MessageBubble';
import type { Conversation } from './seed';
import { currentUser, users } from './seed';

interface MessageListProps {
  conversation: Conversation;
  onImageClick: (url: string) => void;
}

export function MessageList({ conversation, onImageClick }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isGroup = conversation.type === 'group';

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [conversation.messages]);

  const getSender = (senderId: string) =>
    senderId === currentUser.id ? currentUser : users.find((u) => u.id === senderId);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
      {conversation.messages.map((message, index) => {
        const isOwn = message.senderId === currentUser.id;
        const sender = getSender(message.senderId);
        const prevMessage = conversation.messages[index - 1];
        const showSender =
          isGroup && !isOwn && (!prevMessage || prevMessage.senderId !== message.senderId);

        return (
          <MessageBubble
            key={message.id}
            message={message}
            isOwn={isOwn}
            sender={sender}
            showSender={showSender}
            onImageClick={onImageClick}
          />
        );
      })}
    </div>
  );
}
