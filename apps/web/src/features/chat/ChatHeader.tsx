import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Bell,
  BellOff,
  FileText,
  Image as ImageIcon,
  Info,
  LockKeyhole,
  MoreVertical,
  Phone,
  Search,
  Shield,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { Attachment, Conversation, Message } from './seed';
import {
  currentUser,
  formatMessageTime,
  getConversationDisplayName,
  getConversationAvatar,
  getOtherParticipant,
} from './seed';
import {
  Avatar,
  Button,
  IconButton,
  Modal,
  floatingMenuItemClass,
  floatingMenuMotion,
  floatingMenuSurfaceClass,
  modalBackdropEnterMotion,
  modalPanelEnterMotion,
  useToast,
} from '../ui';
import {
  isConversationMuted,
  muteConversation,
  readMutedConversationIds,
  syncMuteStateToCache,
  unmuteConversation,
} from '../settings/conversation-mute';
import { useChatContext } from './ChatContext';

interface ChatHeaderProps {
  conversation: Conversation;
  onBack?: () => void;
  /** Out-of-band safety-number verification state + opener (checkpoint 20). */
  verified?: boolean;
  onVerify?: () => void;
  /** Open the add-member dialog. Provided only for group conversations where the current user is creator. */
  onAddMember?: () => void;
}

type HeaderPanel = 'info' | 'members' | 'search' | 'media' | 'notifications' | 'security';

function MenuItem({
  icon: Icon,
  label,
  value,
  danger = false,
  disabled = false,
  tabIndex,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  value?: string;
  danger?: boolean;
  disabled?: boolean;
  tabIndex?: number;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      tabIndex={tabIndex}
      className={`${floatingMenuItemClass} ${
        danger
          ? 'text-red-300 hover:bg-red-500/10 hover:text-red-200'
          : 'text-white/65 hover:bg-white/[0.05] hover:text-white'
      } disabled:cursor-not-allowed disabled:text-white/25 disabled:hover:bg-transparent`}
      role="menuitem"
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value && <span className="shrink-0 text-xs text-white/60">{value}</span>}
    </button>
  );
}

function PanelRow({ title, value }: { title: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-[0.08em] text-white/60">{title}</p>
      <div className="mt-1 text-sm text-white/75">{value}</div>
    </div>
  );
}

function collectAttachments(messages: Message[]): Array<Attachment & { senderName: string }> {
  return messages.flatMap((message) => {
    const sender = message.senderId === currentUser.id ? currentUser : undefined;
    return (message.attachments ?? []).map((attachment) => ({
      ...attachment,
      senderName: sender?.name ?? 'Participant',
    }));
  });
}

export function ChatHeader({
  conversation,
  onBack,
  verified,
  onVerify,
  onAddMember,
}: ChatHeaderProps) {
  const { startCall, callPhase, convToPeerId, connectionStatus } = useChatContext();
  const [menuOpen, setMenuOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<HeaderPanel | null>(null);
  const [muted, setMuted] = useState(() => isConversationMuted(conversation.id));
  useEffect(() => {
    setMuted(isConversationMuted(conversation.id));
  }, [conversation.id]);
  useEffect(() => {
    const onMutesCleared = () => setMuted(false);
    window.addEventListener('argus:mutes-cleared', onMutesCleared);
    return () => window.removeEventListener('argus:mutes-cleared', onMutesCleared);
  }, []);
  const [searchQuery, setSearchQuery] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const { toast } = useToast();
  const lastCallToastAt = useRef(0);
  const handleComingSoon = useCallback(() => {
    const now = Date.now();
    if (now - lastCallToastAt.current < 2500) return;
    lastCallToastAt.current = now;
    toast('Voice and video calls are coming soon');
  }, [toast]);
  const displayName = getConversationDisplayName(conversation, currentUser.id);
  const avatar = getConversationAvatar(conversation, currentUser.id);
  const otherUser = getOtherParticipant(conversation, currentUser.id);
  // Presence is tri-state: true/false for seed/demo users; UNDEFINED for live remote peers (no presence
  // system) — never claim Online/Offline when it's unknown.
  const presence = conversation.type === 'direct' ? otherUser?.isOnline : undefined;
  const isOnline = presence === true;
  const attachments = useMemo(() => collectAttachments(conversation.messages), [conversation]);
  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return conversation.messages.slice(-5);
    return conversation.messages.filter((message) => message.content.toLowerCase().includes(query));
  }, [conversation.messages, searchQuery]);

  const statusText =
    conversation.type === 'group'
      ? `${conversation.participants.length} members`
      : presence === undefined
        ? 'End-to-end encrypted' // live peer: presence unknown — say something TRUE instead
        : presence
          ? 'Online'
          : 'Offline';
  const menuTabIndex = menuOpen ? 0 : -1;

  useEffect(() => {
    if (!menuOpen) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        setActivePanel(null);
      }
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  const openPanel = (panel: HeaderPanel) => {
    setActivePanel(panel);
    setMenuOpen(false);
  };

  const closePanel = () => {
    setActivePanel(null);
    window.requestAnimationFrame(() => menuButtonRef.current?.focus({ preventScroll: true }));
  };

  const panelTitle =
    activePanel === 'info'
      ? 'Conversation info'
      : activePanel === 'members'
        ? 'Members'
        : activePanel === 'search'
          ? 'Search in conversation'
          : activePanel === 'media'
            ? 'Media, files, links'
            : activePanel === 'notifications'
              ? 'Notifications'
              : 'Security details';

  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-[calc(env(safe-area-inset-top)_+_0.75rem)] z-20 px-2 pl-[calc(env(safe-area-inset-left)_+_0.5rem)] pr-[calc(env(safe-area-inset-right)_+_0.5rem)]">
        <div className="pointer-events-auto flex items-center justify-between gap-2 rounded-2xl bg-[#12121a]/95 px-3 py-2 shadow-[0_2px_24px_rgba(0,0,0,0.55)] ring-1 ring-white/[0.08] backdrop-blur-xl">
          <div className="flex items-center gap-3">
            {onBack && (
              <IconButton
                onClick={onBack}
                className="-ml-2 rounded-xl text-white/60 hover:bg-[#1a1a26] hover:text-white lg:hidden"
                aria-label="Back to conversations"
              >
                <ArrowLeft className="h-5 w-5" />
              </IconButton>
            )}

            <div className="relative">
              <Avatar
                src={avatar}
                name={displayName}
                size="md"
                shape="circle"
                className="ring-2 ring-white/5"
              />
              {isOnline && (
                <div className="absolute bottom-0 right-0 h-3 w-3 rounded-full bg-green-500 ring-2 ring-[#0f0f16]" />
              )}
              {conversation.type === 'group' && (
                <div className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-purple-500 ring-2 ring-[#0f0f16]">
                  <Users className="h-2.5 w-2.5 text-white" />
                </div>
              )}
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h2 className="truncate font-semibold text-white">{displayName}</h2>
                {onVerify && (
                  <IconButton
                    onClick={onVerify}
                    title={verified ? 'Verified — review security' : 'Verify security'}
                    size="xs"
                    className="rounded-md"
                    aria-label={verified ? 'Verified — review security' : 'Verify security'}
                  >
                    {verified ? (
                      <ShieldCheck className="h-4 w-4 text-green-400" />
                    ) : (
                      <Shield className="h-3.5 w-3.5 text-white/60" />
                    )}
                  </IconButton>
                )}
              </div>
              <p className={`text-xs ${isOnline ? 'text-green-400' : 'text-white/60'}`}>
                {statusText}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <IconButton
              onClick={() => {
                const peerUserId = convToPeerId.get(conversation.id);
                if (peerUserId && callPhase.type === 'idle') {
                  void startCall(conversation.id, peerUserId);
                }
              }}
              disabled={
                callPhase.type !== 'idle' ||
                conversation.type !== 'direct' ||
                connectionStatus !== 'connected' ||
                !convToPeerId.get(conversation.id)
              }
              size="lg"
              className={`rounded-xl hover:bg-[#1a1a26] ${
                callPhase.type === 'active' ||
                callPhase.type === 'calling' ||
                callPhase.type === 'negotiating'
                  ? 'text-green-400'
                  : 'text-white/40 hover:text-white/70'
              }`}
              aria-label="Start voice call"
            >
              <Phone className="h-5 w-5" />
            </IconButton>
            <IconButton
              onClick={handleComingSoon}
              size="lg"
              className="rounded-xl text-white/40 hover:bg-[#1a1a26] hover:text-white/70"
              aria-label="Start video call"
            >
              <Video className="h-5 w-5" />
            </IconButton>
            <div ref={menuRef} className="relative">
              <IconButton
                onClick={(event) => {
                  menuButtonRef.current = event.currentTarget;
                  setMenuOpen((open) => !open);
                }}
                size="lg"
                className={`rounded-xl text-white/40 hover:bg-[#1a1a26] hover:text-white/70 ${
                  menuOpen ? 'bg-[#1a1a26] text-white/80' : ''
                }`}
                aria-label="Open conversation actions"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
              >
                <MoreVertical className="h-5 w-5" />
              </IconButton>

              <div
                className={`absolute right-0 top-full z-30 mt-3 w-72 origin-top-right ${floatingMenuSurfaceClass} ${floatingMenuMotion(
                  menuOpen,
                  'top',
                )}`}
                role="menu"
                aria-label="Conversation actions"
                aria-hidden={!menuOpen}
              >
                <MenuItem
                  icon={Info}
                  label="Conversation info"
                  tabIndex={menuTabIndex}
                  onClick={() => openPanel('info')}
                />
                <MenuItem
                  icon={Users}
                  label={conversation.type === 'group' ? 'Members' : 'Contact details'}
                  value={`${conversation.participants.length}`}
                  tabIndex={menuTabIndex}
                  onClick={() => openPanel('members')}
                />
                {conversation.type === 'group' && onAddMember && (
                  <MenuItem
                    icon={UserPlus}
                    label="Add member"
                    tabIndex={menuTabIndex}
                    onClick={() => {
                      setMenuOpen(false);
                      onAddMember();
                    }}
                  />
                )}
                <MenuItem
                  icon={Search}
                  label="Search in conversation"
                  tabIndex={menuTabIndex}
                  onClick={() => openPanel('search')}
                />
                <MenuItem
                  icon={ImageIcon}
                  label="Media, files, links"
                  value={`${attachments.length}`}
                  tabIndex={menuTabIndex}
                  onClick={() => openPanel('media')}
                />
                <MenuItem
                  icon={muted ? Bell : BellOff}
                  label={muted ? 'Unmute conversation' : 'Mute conversation'}
                  value={muted ? undefined : 'in-app only'}
                  tabIndex={menuTabIndex}
                  onClick={() => {
                    const next = !muted;
                    if (next) muteConversation(conversation.id);
                    else unmuteConversation(conversation.id);
                    void syncMuteStateToCache(readMutedConversationIds());
                    setMuted(next);
                    setMenuOpen(false);
                  }}
                />
                <MenuItem
                  icon={LockKeyhole}
                  label="Security details"
                  tabIndex={menuTabIndex}
                  onClick={() => openPanel('security')}
                />
                {onVerify && (
                  <MenuItem
                    icon={verified ? ShieldCheck : Shield}
                    label={verified ? 'Review safety number' : 'Verify safety number'}
                    tabIndex={menuTabIndex}
                    onClick={() => {
                      setMenuOpen(false);
                      onVerify();
                    }}
                  />
                )}
                <div className="my-1 h-px bg-white/5" />
                <MenuItem icon={Trash2} label="Clear local cache" value="Later" disabled />
                <MenuItem
                  icon={UserMinus}
                  label={conversation.type === 'group' ? 'Leave group' : 'Block user'}
                  value="Later"
                  danger
                  disabled
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {activePanel && (
        <Modal
          ariaLabel={panelTitle}
          onClose={closePanel}
          className={`items-end justify-center bg-black/75 p-0 backdrop-blur-sm sm:items-center sm:p-4 ${modalBackdropEnterMotion}`}
          contentClassName={`max-h-[86dvh] w-full overflow-hidden rounded-t-2xl border border-white/5 bg-[#12121a] shadow-2xl shadow-black/50 sm:max-w-lg sm:rounded-2xl ${modalPanelEnterMotion}`}
        >
          <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
            <div>
              <h3 className="text-base font-semibold text-white">{panelTitle}</h3>
              <p className="text-xs text-white/60">{displayName}</p>
            </div>
            <IconButton onClick={closePanel} className="text-white/60" aria-label="Close panel">
              <X className="h-5 w-5" />
            </IconButton>
          </div>

          <div className="max-h-[70dvh] overflow-y-auto p-5 pb-[calc(env(safe-area-inset-bottom)_+_1.25rem)]">
            {activePanel === 'info' && (
              <div className="space-y-3">
                <PanelRow title="Type" value={conversation.type === 'group' ? 'Group' : 'Direct'} />
                <PanelRow title="Status" value={statusText} />
                <PanelRow title="Messages" value={conversation.messages.length} />
                <PanelRow title="Unread" value={conversation.unreadCount} />
              </div>
            )}

            {activePanel === 'members' && (
              <div className="space-y-2">
                {conversation.participants.map((participant) => (
                  <div
                    key={participant.id}
                    className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.03] p-3"
                  >
                    <Avatar
                      src={participant.avatar}
                      name={participant.name}
                      size="sm"
                      shape="circle"
                      className="h-9 w-9 shrink-0 ring-2 ring-white/5"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-white">{participant.name}</p>
                      <p className="text-xs text-white/60">
                        {participant.id === currentUser.id
                          ? 'You'
                          : participant.isOnline === undefined
                            ? 'Member' // live peer: presence unknown — don't claim Online/Offline
                            : participant.isOnline
                              ? 'Online'
                              : 'Offline'}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {activePanel === 'search' && (
              <div className="space-y-3">
                <div className="relative">
                  <Search
                    aria-hidden="true"
                    className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30"
                  />
                  <input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search messages"
                    className="w-full rounded-xl border border-white/5 bg-[#1a1a26] py-2.5 pl-10 pr-4 text-sm text-white placeholder-white/30 transition-all focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/20"
                  />
                </div>
                <div className="space-y-2">
                  {searchResults.map((message) => (
                    <div
                      key={message.id}
                      className="rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3"
                    >
                      <p className="line-clamp-2 text-sm text-white/75">{message.content}</p>
                      <p className="mt-1 text-xs text-white/60">
                        {formatMessageTime(message.timestamp)}
                      </p>
                    </div>
                  ))}
                  {searchResults.length === 0 && (
                    <p className="rounded-xl border border-dashed border-white/10 p-4 text-sm text-white/60">
                      No local message matches.
                    </p>
                  )}
                </div>
              </div>
            )}

            {activePanel === 'media' && (
              <div className="space-y-3">
                {attachments.length > 0 ? (
                  attachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.03] p-3"
                    >
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-500/15">
                        {attachment.type === 'image' ? (
                          <ImageIcon className="h-5 w-5 text-purple-300" />
                        ) : (
                          <FileText className="h-5 w-5 text-purple-300" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-white">{attachment.name}</p>
                        <p className="text-xs text-white/60">
                          {attachment.type === 'image' ? 'Image' : (attachment.size ?? 'File')}
                        </p>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="rounded-xl border border-dashed border-white/10 p-4 text-sm text-white/60">
                    No local media or files in this conversation.
                  </p>
                )}
              </div>
            )}

            {activePanel === 'notifications' && (
              <div className="space-y-3">
                <PanelRow
                  title="In-app alerts"
                  value={muted ? 'Muted (push still delivered)' : 'Enabled'}
                />
                <Button
                  size="lg"
                  onClick={() => {
                    const next = !muted;
                    if (next) muteConversation(conversation.id);
                    else unmuteConversation(conversation.id);
                    void syncMuteStateToCache(readMutedConversationIds());
                    setMuted(next);
                  }}
                  className="w-full"
                >
                  {muted ? 'Unmute conversation' : 'Mute conversation'}
                </Button>
              </div>
            )}

            {activePanel === 'security' && (
              <div className="space-y-3">
                <PanelRow title="Encryption" value="End-to-end encrypted with MLS" />
                <PanelRow
                  title="Server access"
                  value="Ciphertext only; server stays crypto-blind"
                />
                <PanelRow
                  title="Verification"
                  value={verified ? 'Safety number verified' : 'Safety number not verified yet'}
                />
                <PanelRow
                  title="Local cache"
                  value="Messages shown here are decrypted only in this browser"
                />
                {onVerify && (
                  <Button
                    variant="subtle"
                    size="lg"
                    onClick={() => {
                      setActivePanel(null);
                      onVerify();
                    }}
                    className="w-full"
                  >
                    {verified ? 'Review safety number' : 'Verify safety number'}
                  </Button>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
