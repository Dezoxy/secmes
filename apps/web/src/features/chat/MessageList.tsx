import { useEffect, useRef, useState } from 'react';
import { MessageBubble } from './MessageBubble';
import type { Conversation } from './seed';
import { currentUser, users } from './seed';

interface MessageListProps {
  conversation: Conversation;
  onImageClick: (url: string) => void;
  bottomNavClearance?: boolean;
}

export function MessageList({
  conversation,
  onImageClick,
  bottomNavClearance = false,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousMessageCount = useRef(conversation.messages.length);
  const seenMessageIds = useRef(new Set(conversation.messages.map((message) => message.id)));
  const removalTimers = useRef<number[]>([]);
  const [enteringMessageIds, setEnteringMessageIds] = useState<Set<string>>(() => new Set());
  const isGroup = conversation.type === 'group';

  useEffect(
    () => () => {
      removalTimers.current.forEach((timer) => window.clearTimeout(timer));
    },
    [],
  );

  useEffect(() => {
    const node = scrollRef.current;
    if (node) {
      node.scrollTo({
        top: node.scrollHeight,
        behavior: conversation.messages.length > previousMessageCount.current ? 'smooth' : 'auto',
      });
    }

    const newOwnMessageIds = conversation.messages
      .filter(
        (message) => message.senderId === currentUser.id && !seenMessageIds.current.has(message.id),
      )
      .map((message) => message.id);
    if (newOwnMessageIds.length > 0) {
      setEnteringMessageIds((current) => new Set([...current, ...newOwnMessageIds]));
      const timer = window.setTimeout(() => {
        setEnteringMessageIds((current) => {
          const next = new Set(current);
          newOwnMessageIds.forEach((id) => next.delete(id));
          return next;
        });
      }, 320);
      removalTimers.current.push(timer);
    }

    previousMessageCount.current = conversation.messages.length;
    seenMessageIds.current = new Set(conversation.messages.map((message) => message.id));
  }, [conversation.messages]);

  const getSender = (senderId: string) =>
    senderId === currentUser.id ? currentUser : users.find((u) => u.id === senderId);
  const bottomPadding = bottomNavClearance
    ? 'pb-[calc(env(safe-area-inset-bottom)_+_6rem)] lg:pb-4'
    : 'pb-4';

  return (
    <div
      ref={scrollRef}
      role="region"
      aria-label="Message thread"
      aria-live="polite"
      className={`flex-1 space-y-3 overflow-y-auto px-4 pt-4 ${bottomPadding}`}
    >
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
            animateIn={
              isOwn &&
              (!seenMessageIds.current.has(message.id) || enteringMessageIds.has(message.id))
            }
            onImageClick={onImageClick}
          />
        );
      })}
    </div>
  );
}
