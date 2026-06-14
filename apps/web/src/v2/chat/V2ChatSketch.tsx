import { useMemo, useState } from 'react';
import { CheckCheck, Paperclip, Send } from 'lucide-react';
import { v2ClassNames } from '../design/tokens';
import {
  v2Conversations,
  v2MessagesByConversation,
  type V2Conversation,
  type V2Message,
} from '../mocks/sketch-data';
import { V2AsidePanel, V2Badge, V2FactRow, V2SketchShell } from '../shell/V2Shell';

function joinClasses(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function getTrustLabel(status: V2Conversation['status']) {
  if (status === 'pending') return 'Pending verification';
  if (status === 'quiet') return 'Quiet';
  return 'Verified';
}

function getTrustTone(status: V2Conversation['status']) {
  if (status === 'pending') return 'warning';
  if (status === 'verified') return 'verified';
  return 'neutral';
}

function ConversationSwitcher({
  conversations,
  selectedId,
  onSelect,
}: {
  conversations: V2Conversation[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="hidden w-80 shrink-0 border-r border-white/[0.07] bg-[#0d1014] lg:block">
      <div className="border-b border-white/[0.07] px-4 py-4">
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-white/34">Switcher</p>
        <p className="mt-1 text-sm text-white/58">Recent secure conversations</p>
      </div>
      <div className="divide-y divide-white/[0.06]">
        {conversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            onClick={() => onSelect(conversation.id)}
            aria-pressed={conversation.id === selectedId}
            className={joinClasses(
              'flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-white/[0.03]',
              conversation.id === selectedId && 'bg-teal-300/[0.07]',
            )}
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.06] text-sm font-semibold text-white/82">
              {conversation.initials}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-white/86">
                  {conversation.name}
                </span>
                {conversation.status === 'verified' && (
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
                )}
                {conversation.status === 'pending' && (
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
                )}
                {conversation.status === 'quiet' && (
                  <span className="h-1.5 w-1.5 rounded-full bg-white/24" />
                )}
              </span>
              <span className="mt-0.5 block truncate text-xs text-white/42">
                {conversation.preview}
              </span>
            </span>
            <span className="text-xs text-white/32">{conversation.time}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

function MobileConversationTabs({
  conversations,
  selectedId,
  onSelect,
}: {
  conversations: V2Conversation[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto border-b border-white/[0.07] px-4 py-3 lg:hidden">
      {conversations.map((conversation) => (
        <button
          key={conversation.id}
          type="button"
          onClick={() => onSelect(conversation.id)}
          aria-pressed={conversation.id === selectedId}
          className={joinClasses(
            'inline-flex min-h-10 shrink-0 items-center gap-2 rounded-xl border px-3 text-sm transition-colors',
            conversation.id === selectedId
              ? 'border-teal-300/20 bg-teal-300/10 text-teal-100'
              : 'border-white/[0.07] bg-white/[0.025] text-white/52',
            v2ClassNames.focus,
          )}
        >
          <span className="font-semibold">{conversation.initials}</span>
          <span>{conversation.name}</span>
        </button>
      ))}
    </div>
  );
}

function Thread({
  conversation,
  messages,
  onSend,
  onVerify,
}: {
  conversation: V2Conversation;
  messages: V2Message[];
  onSend: (body: string) => void;
  onVerify: () => void;
}) {
  const [draft, setDraft] = useState('');
  const canSend = draft.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    onSend(draft.trim());
    setDraft('');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-3 border-b border-white/[0.07] px-4 py-4 sm:flex-row sm:items-center sm:justify-between md:px-5">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-white">{conversation.name}</h2>
          <div className="mt-1 flex items-center gap-2">
            <V2Badge tone={getTrustTone(conversation.status)}>
              {getTrustLabel(conversation.status)}
            </V2Badge>
            <V2Badge>MLS</V2Badge>
          </div>
        </div>
        <button
          type="button"
          onClick={onVerify}
          className={joinClasses(
            'w-full rounded-lg border border-white/[0.08] px-3 py-2 text-sm text-white/62 hover:bg-white/[0.04] sm:w-auto',
            v2ClassNames.focus,
          )}
        >
          {conversation.status === 'pending' ? 'Verify now' : 'Review verification'}
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-5 md:px-6 md:py-6">
        {messages.map((message) => {
          const own = message.author === 'self';
          return (
            <div
              key={message.id}
              className={joinClasses('flex', own ? 'justify-end' : 'justify-start')}
            >
              <div
                className={joinClasses(
                  'max-w-[34rem] rounded-2xl px-4 py-3 text-sm leading-6',
                  own
                    ? 'bg-teal-300 text-[#07100f]'
                    : 'border border-white/[0.07] bg-white/[0.04] text-white/84',
                )}
              >
                <p>{message.body}</p>
                <div
                  className={joinClasses(
                    'mt-2 flex items-center gap-1.5 text-xs',
                    own ? 'text-[#07100f]/60' : 'text-white/34',
                  )}
                >
                  <span>{message.time}</span>
                  {message.state && (
                    <>
                      <CheckCheck className="h-3.5 w-3.5" />
                      <span>{message.state}</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-white/[0.07] p-3 md:p-4">
        <div className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-[#111418] px-3 py-2">
          <button
            type="button"
            className={joinClasses(
              'rounded-lg p-2 text-white/36 hover:bg-white/[0.04]',
              v2ClassNames.focus,
            )}
            aria-label="Attach file"
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                send();
              }
            }}
            aria-label={`Message ${conversation.name}`}
            placeholder={`Message ${conversation.name}`}
            className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/36"
          />
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            className={joinClasses(
              'rounded-xl bg-teal-300 p-2 text-[#07100f] transition-opacity disabled:cursor-not-allowed disabled:opacity-35',
              v2ClassNames.focus,
            )}
            aria-label="Send message"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function V2ChatSketch() {
  const [selectedId, setSelectedId] = useState(v2Conversations[0]?.id ?? 'sarah');
  const [conversationStatus, setConversationStatus] = useState<
    Record<string, V2Conversation['status']>
  >(
    () =>
      Object.fromEntries(
        v2Conversations.map((conversation) => [conversation.id, conversation.status]),
      ) as Record<string, V2Conversation['status']>,
  );
  const [sentMessagesByConversation, setSentMessagesByConversation] = useState<
    Record<string, V2Message[]>
  >({});
  const conversations = useMemo(
    () =>
      v2Conversations.map((conversation) => ({
        ...conversation,
        status: conversationStatus[conversation.id] ?? conversation.status,
      })),
    [conversationStatus],
  );
  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId) ?? conversations[0]!,
    [conversations, selectedId],
  );
  const visibleMessages = useMemo(
    () => [
      ...(v2MessagesByConversation[selectedConversation.id] ?? []),
      ...(sentMessagesByConversation[selectedConversation.id] ?? []),
    ],
    [selectedConversation.id, sentMessagesByConversation],
  );

  return (
    <V2SketchShell
      active="chat"
      title="Minimal Messenger OS"
      subtitle="A focused v2 chat sketch for the existing /chat route."
      aside={
        <V2AsidePanel title="Thread state">
          <V2FactRow
            label={
              selectedConversation.status === 'pending' ? 'Verification pending' : 'Contact trust'
            }
            value={
              selectedConversation.status === 'pending'
                ? 'This conversation is waiting for manual verification.'
                : selectedConversation.status === 'quiet'
                  ? 'This thread is quiet but still protected by the same local device trust.'
                  : 'Safety number accepted on this browser.'
            }
            tone={getTrustTone(selectedConversation.status)}
          />
          <V2FactRow
            label="MLS active"
            value="Messages are sealed before network delivery."
            tone="verified"
          />
          <V2FactRow label="Device" value="This browser is trusted for the current account." />
        </V2AsidePanel>
      }
    >
      <div className="flex h-[calc(100vh-16rem)] min-h-0 flex-col md:h-[calc(100vh-9rem)] md:min-h-[34rem] lg:flex-row xl:h-[calc(100vh-5rem)]">
        <MobileConversationTabs
          conversations={conversations}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
        <ConversationSwitcher
          conversations={conversations}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
        <Thread
          conversation={selectedConversation}
          messages={visibleMessages}
          onSend={(body) =>
            setSentMessagesByConversation((current) => {
              const threadMessages = current[selectedConversation.id] ?? [];
              return {
                ...current,
                [selectedConversation.id]: [
                  ...threadMessages,
                  {
                    id: `${selectedConversation.id}-local-${threadMessages.length + 1}`,
                    author: 'self',
                    body,
                    time: 'Now',
                    state: 'Local sketch',
                  },
                ],
              };
            })
          }
          onVerify={() =>
            setConversationStatus((current) => ({
              ...current,
              [selectedConversation.id]: 'verified',
            }))
          }
        />
      </div>
    </V2SketchShell>
  );
}
