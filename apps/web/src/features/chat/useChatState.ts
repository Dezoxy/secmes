import { useCallback, useMemo } from 'react';
import type { Conversation } from './seed';

interface ChatStateInput {
  conversations: Conversation[];
  selectedId: string | null;
  liveIds: ReadonlySet<string>;
  numbersByConv: Record<string, string>;
  verifiedByConv: Record<string, string>;
}

export interface ReadOnlyChatState {
  selectedConversation: Conversation | undefined;
  isDirect: boolean;
  selectedIsLive: boolean;
  currentNumber: string | null;
  verified: boolean;
}

export function deriveReadOnlyChatState({
  conversations,
  selectedId,
  liveIds,
  numbersByConv,
  verifiedByConv,
}: ChatStateInput): ReadOnlyChatState {
  const selectedConversation = conversations.find((conversation) => conversation.id === selectedId);
  const isDirect = selectedConversation?.type === 'direct';
  const selectedIsLive = selectedId !== null && liveIds.has(selectedId);
  const currentNumber = selectedId ? (numbersByConv[selectedId] ?? null) : null;
  const verified =
    isDirect &&
    selectedId !== null &&
    currentNumber !== null &&
    verifiedByConv[selectedId] === currentNumber;

  return {
    selectedConversation,
    isDirect,
    selectedIsLive,
    currentNumber,
    verified,
  };
}

export function useChatState(input: ChatStateInput): ReadOnlyChatState & {
  isLive: (id: string | null) => boolean;
} {
  const { conversations, selectedId, liveIds, numbersByConv, verifiedByConv } = input;
  const isLive = useCallback(
    (id: string | null): boolean => id !== null && liveIds.has(id),
    [liveIds],
  );
  const readOnlyState = useMemo(
    () =>
      deriveReadOnlyChatState({
        conversations,
        selectedId,
        liveIds,
        numbersByConv,
        verifiedByConv,
      }),
    [conversations, selectedId, liveIds, numbersByConv, verifiedByConv],
  );

  return useMemo(() => ({ ...readOnlyState, isLive }), [readOnlyState, isLive]);
}
