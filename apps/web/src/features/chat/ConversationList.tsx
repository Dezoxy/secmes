import { useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Search,
  UserMinus,
  UserPlus,
  Users,
  Settings,
  RefreshCw,
  Check,
  X,
} from 'lucide-react';
import {
  lookupUserByArgusId,
  type Friend,
  type FriendRequest,
  type UserLookupResult,
} from '../../lib/api';
import type { Conversation, User } from './seed';
import {
  currentUser,
  getConversationDisplayName,
  getConversationAvatar,
  getOtherParticipant,
  formatMessageTime,
} from './seed';
import { Avatar, Button, EmptyState, conversationEnterMotion, paneBackEnterMotion } from '../ui';
import { dicebearAvatar } from '../../lib/dicebear';

const ARGUS_ID_RE = /^argus-[abcdefghjkmnpqrstuvwxyz23456789]{16}-[a-z]+$/;

type SidebarMode = 'conversations' | 'friends';
type SidebarTransition = 'forward' | 'back' | null;

function normalizedContactText(value: string): string {
  return value.trim().toLowerCase();
}

function friendDisplayName(friend: Friend): string {
  return friend.displayName ?? friend.argusId;
}

function filterFriends(friends: Friend[], rawQuery: string): Friend[] {
  const query = normalizedContactText(rawQuery);
  if (!query) return friends;
  return friends.filter((f) =>
    [f.displayName, f.argusId]
      .filter((v): v is string => Boolean(v))
      .join(' ')
      .toLowerCase()
      .includes(query),
  );
}

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  currentUserProfile?: User;
  /** Opens account settings. */
  onSettings?: (trigger: HTMLButtonElement) => void;
  /** Starts the group create flow. Absent in demo mode → button hidden. (1:1 chats start from the
   *  Friends list via onTapFriend, so there is no separate "new 1:1" button.) */
  onNewGroup?: () => void;
  /** Shows the installed-app update action when a newer PWA shell is waiting. */
  updateReady?: boolean;
  /** Applies the waiting PWA shell update and reloads the app. */
  onApplyUpdate?: () => void | Promise<void>;

  // ── Friends panel (real API data; all absent in demo / unauthenticated mode) ──
  /** Accepted friends from GET /friends. */
  friends?: Friend[];
  /** Pending incoming requests from GET /friends/requests?box=incoming. */
  incomingRequests?: FriendRequest[];
  /** Pending outgoing requests from GET /friends/requests?box=outgoing. */
  outgoingRequests?: FriendRequest[];
  /** Called when user taps an accepted friend — ChatScreen handles routing. */
  onTapFriend?: (friend: Friend) => void;
  /** Called when user submits a new friend request by argus-id. */
  onSendFriendRequest?: (argusId: string) => Promise<void>;
  onAcceptRequest?: (requestId: string) => Promise<void>;
  onDeclineRequest?: (requestId: string) => Promise<void>;
  onCancelRequest?: (requestId: string) => Promise<void>;
  onUnfriend?: (userId: string) => Promise<void>;
  /** Set when the last friends data fetch failed — shows a non-blocking hint. */
  friendsLoadError?: boolean;
  /** Called when the friends panel is opened — triggers a lazy data fetch. */
  onFriendsOpen?: () => Promise<void>;
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  currentUserProfile = currentUser,
  onSettings,
  onNewGroup,
  updateReady = false,
  onApplyUpdate,
  friends,
  incomingRequests,
  outgoingRequests,
  onTapFriend,
  onSendFriendRequest,
  onAcceptRequest,
  onDeclineRequest,
  onCancelRequest,
  onUnfriend,
  friendsLoadError,
  onFriendsOpen,
}: ConversationListProps) {
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('conversations');
  const [sidebarTransition, setSidebarTransition] = useState<SidebarTransition>(null);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [friendQuery, setFriendQuery] = useState('');
  const [sendingRequest, setSendingRequest] = useState(false);
  const [sentArgusId, setSentArgusId] = useState<string | null>(null);
  const [sendRequestError, setSendRequestError] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupResult, setLookupResult] = useState<UserLookupResult | null>(null);
  const [sentDisplayName, setSentDisplayName] = useState<string | null>(null);
  const [confirmingUnfriendId, setConfirmingUnfriendId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const touchStartY = useRef<number | null>(null);
  const searchTouchStartY = useRef<number | null>(null);
  const sidebarTouchStartY = useRef<number | null>(null);
  // Tracks the query string that triggered the most recent in-flight lookup. Cleared to null on every
  // input change so that a stale response arriving after the user edited the field is discarded.
  const infightLookupQuery = useRef<string | null>(null);

  const effectiveFriends = friends ?? [];
  const filteredFriends = useMemo(
    () => filterFriends(effectiveFriends, friendQuery),
    [effectiveFriends, friendQuery],
  );
  const trimmedFriendQuery = friendQuery.trim();
  const effectiveOutgoing = outgoingRequests ?? [];
  const effectiveIncoming = incomingRequests ?? [];

  // Show the "send request" CTA when the query doesn't match any accepted friend.
  const showFriendRequestAction = trimmedFriendQuery.length > 0 && filteredFriends.length === 0;
  const pendingForQuery =
    sentArgusId !== null &&
    normalizedContactText(sentArgusId) === normalizedContactText(trimmedFriendQuery);

  const revealSearch = () => setSearchVisible(true);

  const hideSearch = () => {
    searchInputRef.current?.blur();
    setSearchFocused(false);
    setSearchVisible(false);
  };

  const hideSearchIfIdle = () => {
    if (!searchFocused) setSearchVisible(false);
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const scrollTop = listRef.current?.scrollTop ?? 0;
    if (event.deltaY < -12 && scrollTop <= 2) revealSearch();
    if (event.deltaY > 12) {
      if (searchVisible) hideSearch();
      else if (scrollTop > 12) hideSearchIfIdle();
    }
  };

  const handleSidebarWheelCapture = (event: React.WheelEvent<HTMLDivElement>) => {
    if (searchVisible && event.deltaY > 12) hideSearch();
  };

  const handleSidebarTouchStartCapture = (event: React.TouchEvent<HTMLDivElement>) => {
    if (searchVisible) sidebarTouchStartY.current = event.touches[0]?.clientY ?? null;
  };

  const handleSidebarTouchMoveCapture = (event: React.TouchEvent<HTMLDivElement>) => {
    const startY = sidebarTouchStartY.current;
    const currentY = event.touches[0]?.clientY;
    if (startY === null || currentY === undefined) return;
    if (currentY - startY < -28) hideSearch();
  };

  const handleSidebarTouchEndCapture = () => {
    sidebarTouchStartY.current = null;
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (searchVisible || (listRef.current?.scrollTop ?? 0) <= 2) {
      touchStartY.current = event.touches[0]?.clientY ?? null;
    }
  };

  const handleTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const startY = touchStartY.current;
    const currentY = event.touches[0]?.clientY;
    if (startY === null || currentY === undefined) return;
    if (currentY - startY > 28 && (listRef.current?.scrollTop ?? 0) <= 2) {
      revealSearch();
    }
    if (currentY - startY < -28 && searchVisible) {
      hideSearch();
    }
  };

  const handleTouchEnd = () => {
    touchStartY.current = null;
  };

  const handleSearchWheel = (event: React.WheelEvent<HTMLElement>) => {
    if (event.deltaY > 12) hideSearch();
  };

  const handleSearchTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    searchTouchStartY.current = event.touches[0]?.clientY ?? null;
  };

  const handleSearchTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const startY = searchTouchStartY.current;
    const currentY = event.touches[0]?.clientY;
    if (startY === null || currentY === undefined) return;
    if (currentY - startY < -28) hideSearch();
  };

  const handleSearchTouchEnd = () => {
    searchTouchStartY.current = null;
  };

  const focusSearch = () => {
    revealSearch();
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  };

  const openFriendsPanel = () => {
    hideSearch();
    void onFriendsOpen?.();
    setSidebarTransition('forward');
    setSidebarMode('friends');
  };

  const closeFriendsPanel = () => {
    setFriendQuery('');
    setSentArgusId(null);
    setSendRequestError(null);
    setLookupResult(null);
    setSentDisplayName(null);
    setConfirmingUnfriendId(null);
    setSidebarTransition('back');
    setSidebarMode('conversations');
  };

  const handleSidebarAnimationEnd = (event: React.AnimationEvent<HTMLDivElement>) => {
    if (event.currentTarget === event.target) setSidebarTransition(null);
  };

  const handleSendRequest = async () => {
    if (!onSendFriendRequest || !trimmedFriendQuery || lookingUp || sendingRequest) return;
    setSendRequestError(null);
    if (!ARGUS_ID_RE.test(trimmedFriendQuery)) {
      setSendRequestError('Invalid argus ID — paste the exact ID from their profile.');
      return;
    }
    const querySnapshot = trimmedFriendQuery;
    infightLookupQuery.current = querySnapshot;
    setLookingUp(true);
    try {
      const result = await lookupUserByArgusId(querySnapshot);
      if (infightLookupQuery.current !== querySnapshot) return;
      if (!result) {
        setSendRequestError('No user found with that argus-id.');
      } else {
        setLookupResult(result);
      }
    } catch {
      if (infightLookupQuery.current === querySnapshot) {
        setSendRequestError('Lookup failed. Check the id and try again.');
      }
    } finally {
      setLookingUp(false);
    }
  };

  const handleConfirmSend = async () => {
    if (!onSendFriendRequest || !lookupResult || sendingRequest) return;
    setSendingRequest(true);
    setSendRequestError(null);
    const { argusId: canonicalId, displayName: resolvedName } = lookupResult;
    const displayName = resolvedName ?? canonicalId;
    try {
      await onSendFriendRequest(canonicalId);
      setSentArgusId(canonicalId);
      setSentDisplayName(displayName);
      setLookupResult(null);
    } catch {
      setSendRequestError('Could not send request. Try again in a moment.');
    } finally {
      setSendingRequest(false);
    }
  };

  const friendsPanelMotion = sidebarTransition === 'forward' ? conversationEnterMotion : '';
  const conversationsPanelMotion = sidebarTransition === 'back' ? paneBackEnterMotion : '';

  if (sidebarMode === 'friends') {
    return (
      <div
        className={`flex h-full flex-col ${friendsPanelMotion}`}
        onAnimationEnd={handleSidebarAnimationEnd}
      >
        <div className="border-b border-white/5 p-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={closeFriendsPanel}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/55 transition-colors hover:bg-white/[0.05] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#12121a]"
              aria-label="Back to conversations"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold text-white">Friends</h2>
              <p className="truncate text-xs text-white/45">
                {effectiveFriends.length} accepted{' '}
                {effectiveFriends.length === 1 ? 'friend' : 'friends'}
              </p>
            </div>
          </div>

          <div className="relative mt-4">
            <Search
              aria-hidden="true"
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30"
            />
            <input
              type="text"
              value={friendQuery}
              onChange={(event) => {
                setFriendQuery(event.target.value);
                setSendRequestError(null);
                setLookupResult(null);
                infightLookupQuery.current = null;
              }}
              aria-label="Search friends or enter Argus ID"
              placeholder="Search friends or enter Argus ID..."
              className="w-full rounded-xl border border-white/5 bg-[#1a1a26] py-2.5 pl-10 pr-4 text-sm text-white placeholder-white/30 transition-colors focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/20"
            />
          </div>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto px-2 py-3">
          {friendsLoadError && (
            <p className="mx-2 text-xs text-amber-400/70">
              Could not refresh friends — data may be stale.
            </p>
          )}

          {effectiveFriends.length === 0 && (
            <EmptyState title="No accepted friends yet" icon={Users} compact className="mx-2 mt-4">
              Add friends by their Argus ID to keep contacts after reinstall.
            </EmptyState>
          )}

          {filteredFriends.map((friend) => (
            <div
              key={friend.userId}
              className="flex items-center gap-2 rounded-xl border border-transparent p-3 transition-colors hover:bg-[#1a1a26]"
            >
              <button
                type="button"
                onClick={() => {
                  closeFriendsPanel();
                  onTapFriend?.(friend);
                }}
                className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0f0f16]"
                aria-label={`Open friend ${friendDisplayName(friend)}`}
              >
                <div className="relative shrink-0" aria-hidden="true">
                  <Avatar
                    src={dicebearAvatar(friend.userId)}
                    name={friendDisplayName(friend)}
                    size="md"
                    shape="circle"
                    className="ring-2 ring-white/5"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white/90">
                    {friendDisplayName(friend)}
                  </p>
                  <p className="truncate font-mono text-xs text-white/40">{friend.argusId}</p>
                </div>
              </button>
              {onUnfriend && confirmingUnfriendId !== friend.userId && (
                <button
                  type="button"
                  aria-label={`Remove friend ${friendDisplayName(friend)}`}
                  onClick={() => setConfirmingUnfriendId(friend.userId)}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-white/40 transition-colors hover:bg-red-500/15 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
                >
                  <UserMinus className="h-4 w-4" />
                </button>
              )}
              {onUnfriend && confirmingUnfriendId === friend.userId && (
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    aria-label={`Confirm remove ${friendDisplayName(friend)}`}
                    onClick={() => {
                      setConfirmingUnfriendId(null);
                      void onUnfriend(friend.userId);
                    }}
                    className="inline-flex h-8 items-center justify-center rounded-lg bg-red-500/15 px-2 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
                  >
                    Remove
                  </button>
                  <button
                    type="button"
                    aria-label="Cancel remove"
                    onClick={() => setConfirmingUnfriendId(null)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.04] text-white/50 transition-colors hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          ))}

          {showFriendRequestAction && (
            <div className="mx-2 rounded-xl border border-white/5 bg-white/[0.03] p-3">
              {pendingForQuery ? (
                <p className="rounded-lg border border-emerald-400/20 bg-emerald-500/[0.08] px-3 py-2 text-sm font-medium text-emerald-200">
                  Request sent{sentDisplayName ? ` to ${sentDisplayName}` : ''}
                </p>
              ) : lookupResult ? (
                <>
                  <p className="text-sm font-medium text-white/85">Send a friend request to:</p>
                  <div className="mt-2 flex items-center gap-3">
                    <Avatar
                      src={dicebearAvatar(lookupResult.userId)}
                      name={lookupResult.displayName ?? lookupResult.argusId}
                      size="md"
                      shape="circle"
                      className="shrink-0 ring-2 ring-white/5"
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-white/90">
                        {lookupResult.displayName ?? lookupResult.argusId}
                      </p>
                      <p className="truncate font-mono text-xs text-white/45">
                        {lookupResult.argusId}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Button
                      onClick={() => void handleConfirmSend()}
                      disabled={sendingRequest}
                      variant="subtle"
                      size="md"
                      className="flex-1"
                    >
                      <UserPlus className="h-4 w-4" />
                      {sendingRequest ? 'Sending…' : 'Send request'}
                    </Button>
                    <button
                      type="button"
                      onClick={() => setLookupResult(null)}
                      disabled={sendingRequest}
                      aria-label="Cancel"
                      className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-white/5 bg-white/[0.04] text-white/50 transition-colors hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  {sendRequestError && (
                    <p className="mt-2 text-xs text-red-400">{sendRequestError}</p>
                  )}
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-white/85">
                    No accepted friend found for that Argus ID.
                  </p>
                  <p className="mt-1 truncate font-mono text-xs text-white/45">
                    {trimmedFriendQuery}
                  </p>
                  {onSendFriendRequest && (
                    <>
                      <Button
                        onClick={() => void handleSendRequest()}
                        disabled={lookingUp || sendingRequest}
                        variant="subtle"
                        size="md"
                        className="mt-3 w-full"
                      >
                        <UserPlus className="h-4 w-4" />
                        {lookingUp ? 'Looking up…' : 'Send friend request'}
                      </Button>
                      {sendRequestError && (
                        <p className="mt-2 text-xs text-red-400">{sendRequestError}</p>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {effectiveIncoming.length > 0 && (
            <div className="mx-2 pt-2">
              <p className="mb-2 px-1 text-xs font-medium uppercase tracking-[0.08em] text-white/35">
                Incoming requests
              </p>
              <div className="space-y-1">
                {effectiveIncoming.map((req) => (
                  <div
                    key={req.requestId}
                    className="flex items-center gap-2 rounded-xl border border-white/5 bg-[#1a1a26] px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-white/85">
                        {req.displayName ?? req.argusId}
                      </p>
                      <p className="truncate font-mono text-xs text-white/45">{req.argusId}</p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        aria-label={`Accept request from ${req.displayName ?? req.argusId}`}
                        onClick={() => void onAcceptRequest?.(req.requestId)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-300 transition-colors hover:bg-emerald-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Decline request from ${req.displayName ?? req.argusId}`}
                        onClick={() => void onDeclineRequest?.(req.requestId)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.04] text-white/50 transition-colors hover:bg-white/[0.08] hover:text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {effectiveOutgoing.length > 0 && (
            <div className="mx-2 pt-2">
              <p className="mb-2 px-1 text-xs font-medium uppercase tracking-[0.08em] text-white/35">
                Outgoing requests
              </p>
              <div className="space-y-1">
                {effectiveOutgoing.map((req) => (
                  <div
                    key={req.requestId}
                    className="flex items-center gap-2 rounded-xl border border-white/5 bg-[#1a1a26] px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-white/85">
                        {req.displayName ?? req.argusId}
                      </p>
                      <p className="truncate font-mono text-xs text-white/45">{req.argusId}</p>
                    </div>
                    <button
                      type="button"
                      aria-label={`Cancel request to ${req.displayName ?? req.argusId}`}
                      onClick={() => void onCancelRequest?.(req.requestId)}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
                    >
                      <X className="h-3.5 w-3.5" />
                      Cancel
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`flex h-full flex-col ${conversationsPanelMotion}`}
      onAnimationEnd={handleSidebarAnimationEnd}
      onWheelCapture={handleSidebarWheelCapture}
      onTouchStartCapture={handleSidebarTouchStartCapture}
      onTouchMoveCapture={handleSidebarTouchMoveCapture}
      onTouchEndCapture={handleSidebarTouchEndCapture}
    >
      {/* User Profile Section */}
      <div className="p-4 border-b border-white/5">
        <button
          type="button"
          onClick={(event) => onSettings?.(event.currentTarget)}
          className="w-full flex items-center gap-3 p-2 rounded-xl hover:bg-[#1a1a26] transition-all duration-300 group"
        >
          <span className="sr-only">Open settings</span>
          <div className="relative shrink-0" aria-hidden="true">
            <Avatar
              src={currentUserProfile.avatar}
              name={currentUserProfile.name}
              size="md"
              shape="circle"
              className="ring-2 ring-purple-500/50"
            />
            <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full ring-2 ring-[#12121a]" />
          </div>
          <div className="flex-1 min-w-0 text-left">
            <p className="text-white font-medium text-sm truncate">{currentUserProfile.name}</p>
            <p className="text-white/55 text-xs truncate">Online</p>
          </div>
          <div className="flex items-center gap-1">
            <span className="p-1.5 rounded-lg text-white/60 group-hover:text-white transition-all duration-300">
              <Settings className="w-4 h-4" />
            </span>
          </div>
        </button>
        <button
          type="button"
          onClick={openFriendsPanel}
          className="mt-3 flex w-full items-center gap-3 rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2.5 text-left text-sm text-white/70 transition-all duration-300 hover:border-purple-500/30 hover:bg-[#1a1a26] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#12121a]"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-purple-500/15 text-purple-200">
            <Users className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium">Friends</span>
            <span className="block truncate text-xs text-white/40">
              {effectiveFriends.length} accepted
            </span>
          </span>
          {effectiveIncoming.length > 0 && (
            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-purple-500 px-1.5 text-xs font-semibold text-white">
              {effectiveIncoming.length}
            </span>
          )}
        </button>
      </div>

      {/* New Group (1:1 chats start from the Friends list via onTapFriend). */}
      {onNewGroup && (
        <div className="px-4 pt-4 pb-2">
          <Button
            onClick={onNewGroup}
            size="lg"
            variant="subtle"
            className="w-full shadow-purple-500/10 hover:-translate-y-0.5 active:translate-y-0"
          >
            <Users className="w-4 h-4" />
            Group
          </Button>
        </div>
      )}

      {/* Pull-down Search */}
      <div
        onWheel={handleSearchWheel}
        onTouchStart={handleSearchTouchStart}
        onTouchMove={handleSearchTouchMove}
        onTouchEnd={handleSearchTouchEnd}
        className={`overflow-hidden transition-all duration-300 ease-out ${
          searchVisible
            ? 'max-h-20 translate-y-0 opacity-100'
            : 'pointer-events-none max-h-0 -translate-y-2 opacity-0'
        }`}
        aria-hidden={!searchVisible}
      >
        <div className="px-4 pb-3 pt-2">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30"
            />
            <input
              ref={searchInputRef}
              type="text"
              aria-label="Search conversations"
              tabIndex={searchVisible ? undefined : -1}
              placeholder="Search conversations..."
              onWheel={handleSearchWheel}
              onTouchStart={handleSearchTouchStart}
              onTouchMove={handleSearchTouchMove}
              onTouchEnd={handleSearchTouchEnd}
              onFocus={() => {
                setSearchFocused(true);
                revealSearch();
              }}
              onBlur={() => setSearchFocused(false)}
              className="w-full rounded-xl border border-white/5 bg-[#1a1a26] py-2.5 pl-10 pr-4 text-sm text-white placeholder-white/30 transition-all duration-300 focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/20"
            />
          </div>
        </div>
      </div>

      <div
        className={`overflow-hidden px-4 transition-all duration-300 ${
          searchVisible ? 'max-h-0 py-0 opacity-0' : 'max-h-9 py-1 opacity-100'
        }`}
      >
        <button
          type="button"
          onClick={focusSearch}
          className="group mx-auto flex h-7 w-12 items-center justify-center rounded-full transition-colors duration-300 hover:bg-white/[0.03]"
          aria-label="Reveal conversation search"
        >
          <span className="block h-1 w-10 rounded-full bg-white/15 transition-colors duration-300 group-hover:bg-white/25" />
        </button>
      </div>

      {/* List */}
      <div
        ref={listRef}
        onWheel={handleWheel}
        onScroll={hideSearchIfIdle}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className="flex-1 overflow-y-auto px-2 space-y-1"
      >
        {conversations.length === 0 && (
          <EmptyState title="No conversations yet" icon={Users} compact className="mx-2 mt-4">
            Start a secure conversation when another member is available.
          </EmptyState>
        )}

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
              aria-pressed={isSelected}
              className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all duration-300 group ${
                isSelected
                  ? 'bg-purple-500/20 border border-purple-500/30'
                  : 'hover:bg-[#1a1a26] border border-transparent'
              }`}
            >
              <span className="sr-only">Open conversation with</span>
              <div className="relative shrink-0" aria-hidden="true">
                <Avatar
                  src={avatar}
                  name={displayName}
                  size="lg"
                  shape="circle"
                  className="ring-2 ring-white/5"
                />
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
                    <span className="text-xs text-white/55 shrink-0">
                      {formatMessageTime(lastMessage.timestamp)}
                    </span>
                  )}
                </div>
                {lastMessage && (
                  <div className="flex items-center gap-2 mt-0.5">
                    <p className="text-sm text-white/60 truncate">
                      {lastMessage.senderId === currentUser.id && (
                        <span className="text-white/60">You: </span>
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

      {updateReady && onApplyUpdate && (
        <div
          className="relative shrink-0 bg-[#0f0f16] px-4 pb-4 pt-3 before:absolute before:left-0 before:right-[-1px] before:top-0 before:h-px before:bg-white/5"
          role="status"
          aria-live="polite"
        >
          <button
            type="button"
            onClick={() => void onApplyUpdate()}
            aria-label="Update Argus"
            className="mx-auto flex h-9 items-center gap-2 rounded-full border border-purple-400/30 bg-purple-500/15 px-4 text-sm font-semibold text-purple-100 shadow-lg shadow-purple-950/25 transition-all duration-300 hover:-translate-y-0.5 hover:border-purple-300/50 hover:bg-purple-500/25 active:translate-y-0"
          >
            <RefreshCw className="h-4 w-4" />
            Update
          </button>
        </div>
      )}
    </div>
  );
}
