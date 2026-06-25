import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, UserMinus, UserPlus, Users, Check, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { lookupUserByArgusId, type Friend, type UserLookupResult } from '../../lib/api';
import { useChatContext } from '../chat/ChatContext';
import { Avatar, Button, EmptyState } from '../ui';
import { dicebearAvatar } from '../../lib/dicebear';
import { ArgusAppIcon } from '../brand/ArgusAppIcon';

const ARGUS_ID_RE = /^argus-[abcdefghjkmnpqrstuvwxyz23456789]{16}-[a-z]+$/;

function friendDisplayName(friend: Friend): string {
  return friend.displayName ?? friend.argusId;
}

function filterFriends(friends: Friend[], rawQuery: string): Friend[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return friends;
  return friends.filter((f) =>
    [f.displayName, f.argusId]
      .filter((v): v is string => Boolean(v))
      .join(' ')
      .toLowerCase()
      .includes(query),
  );
}

export default function FriendsScreen() {
  const navigate = useNavigate();
  const {
    conversations,
    friends,
    incomingRequests,
    outgoingRequests,
    friendsError,
    manager,
    refreshFriends,
    handleSendFriendRequest,
    handleAcceptRequest,
    handleDeclineRequest,
    handleCancelRequest,
    handleUnfriend,
  } = useChatContext();

  // Mutation actions are only available in authenticated mode (manager present).
  const canMutate = manager !== null;

  // Refresh the friends list when the tab is opened so stale state is cleared immediately.
  // Call unconditionally: the API is accessible in demo mode too, and the auth/error
  // handling inside refreshFriends is sufficient (it silently ignores failures without manager).
  useEffect(() => {
    void refreshFriends();
  }, [refreshFriends]);

  const [friendQuery, setFriendQuery] = useState('');
  const [sendingRequest, setSendingRequest] = useState(false);
  const [sentArgusId, setSentArgusId] = useState<string | null>(null);
  const [sendRequestError, setSendRequestError] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupResult, setLookupResult] = useState<UserLookupResult | null>(null);
  const [sentDisplayName, setSentDisplayName] = useState<string | null>(null);
  const [confirmingUnfriendId, setConfirmingUnfriendId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const infightLookupQuery = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef<number | null>(null);
  const sidebarTouchStartY = useRef<number | null>(null);
  const searchTouchStartY = useRef<number | null>(null);

  const revealSearch = () => setSearchOpen(true);

  const hideSearch = () => {
    searchInputRef.current?.blur();
    setSearchFocused(false);
    setSearchOpen(false);
    setFriendQuery('');
    setLookupResult(null);
    setSendRequestError(null);
    infightLookupQuery.current = null;
  };

  const hideSearchIfIdle = () => {
    if (!searchFocused) setSearchOpen(false);
  };

  const focusSearch = () => {
    revealSearch();
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const scrollTop = listRef.current?.scrollTop ?? 0;
    if (event.deltaY < -12 && scrollTop <= 2) revealSearch();
    if (event.deltaY > 12) {
      if (searchOpen) hideSearch();
      else if (scrollTop > 12) hideSearchIfIdle();
    }
  };

  const handleSidebarWheelCapture = (event: React.WheelEvent<HTMLDivElement>) => {
    if (searchOpen && event.deltaY > 12) hideSearch();
  };

  const handleSidebarTouchStartCapture = (event: React.TouchEvent<HTMLDivElement>) => {
    if (searchOpen) sidebarTouchStartY.current = event.touches[0]?.clientY ?? null;
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
    if (searchOpen || (listRef.current?.scrollTop ?? 0) <= 2) {
      touchStartY.current = event.touches[0]?.clientY ?? null;
    }
  };

  const handleTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const startY = touchStartY.current;
    const currentY = event.touches[0]?.clientY;
    if (startY === null || currentY === undefined) return;
    if (currentY - startY > 28 && (listRef.current?.scrollTop ?? 0) <= 2) revealSearch();
    if (currentY - startY < -28 && searchOpen) hideSearch();
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

  const trimmedFriendQuery = friendQuery.trim();
  const filteredFriends = useMemo(
    () => filterFriends(friends, friendQuery),
    [friends, friendQuery],
  );
  const showFriendRequestAction = trimmedFriendQuery.length > 0 && filteredFriends.length === 0;
  const pendingForQuery =
    sentArgusId !== null && sentArgusId.toLowerCase() === trimmedFriendQuery.toLowerCase();

  const findExistingConversation = (userId: string): string | null =>
    conversations.find((c) => c.type === 'direct' && c.participants.some((p) => p.id === userId))
      ?.id ?? null;

  const handleTapFriend = (friend: Friend) => {
    const existingId = findExistingConversation(friend.userId);
    if (existingId) {
      navigate('/chat', { state: { selectedId: existingId } });
    } else {
      navigate('/chat', { state: { startArgusId: friend.argusId } });
    }
  };

  const handleSendRequest = async () => {
    if (!trimmedFriendQuery || lookingUp || sendingRequest) return;
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
    if (!lookupResult || sendingRequest) return;
    setSendingRequest(true);
    setSendRequestError(null);
    const { argusId: canonicalId, displayName: resolvedName } = lookupResult;
    const displayName = resolvedName ?? canonicalId;
    try {
      await handleSendFriendRequest(canonicalId);
      setSentArgusId(canonicalId);
      setSentDisplayName(displayName);
      setLookupResult(null);
    } catch {
      setSendRequestError('Could not send request. Try again in a moment.');
    } finally {
      setSendingRequest(false);
    }
  };

  return (
    <div className="relative h-full lg:flex lg:items-center lg:justify-center lg:bg-[#1a1a24] lg:p-4">
      <div
        className="flex h-full flex-col overflow-hidden bg-[#0f0f16] lg:h-[calc(100%-2rem)] lg:w-full lg:max-w-2xl lg:rounded-3xl lg:bg-[#12121a] lg:shadow-2xl lg:shadow-black/50"
        onWheelCapture={handleSidebarWheelCapture}
        onTouchStartCapture={handleSidebarTouchStartCapture}
        onTouchMoveCapture={handleSidebarTouchMoveCapture}
        onTouchEndCapture={handleSidebarTouchEndCapture}
      >
        <div className="bg-[#0f0f16] p-4 pt-[env(safe-area-inset-top)] lg:pt-4 lg:bg-[#12121a]">
          <div className="flex items-center gap-2">
            <ArgusAppIcon className="h-8 w-8 rounded-lg shadow-sm shadow-purple-500/25" />
            <div className="flex-1 text-center">
              <h1 className="text-xl font-bold tracking-wider">
                <span className="bg-gradient-to-r from-[var(--argus-brand-400)] to-[var(--argus-brand-600)] bg-clip-text text-transparent">
                  FRIENDS
                </span>
              </h1>
              <p className="text-xs text-white/45">
                {friends.length} accepted {friends.length === 1 ? 'friend' : 'friends'}
              </p>
            </div>
          </div>

          {/* Search input — slides in when open */}
          <div
            id="friend-search-panel"
            onWheel={handleSearchWheel}
            onTouchStart={handleSearchTouchStart}
            onTouchMove={handleSearchTouchMove}
            onTouchEnd={handleSearchTouchEnd}
            className={`overflow-hidden transition-all duration-300 ease-out ${
              searchOpen ? 'mt-3 max-h-20 opacity-100' : 'pointer-events-none max-h-0 opacity-0'
            }`}
            aria-hidden={!searchOpen}
          >
            <div className="relative">
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
                onWheel={handleSearchWheel}
                onTouchStart={handleSearchTouchStart}
                onTouchMove={handleSearchTouchMove}
                onTouchEnd={handleSearchTouchEnd}
                onFocus={() => {
                  setSearchFocused(true);
                  revealSearch();
                }}
                onBlur={() => setSearchFocused(false)}
                aria-label="Search friends or enter Argus ID"
                placeholder="Search friends or enter Argus ID..."
                ref={searchInputRef}
                tabIndex={searchOpen ? undefined : -1}
                className="w-full rounded-xl border border-white/5 bg-[#1a1a26] py-2.5 pl-10 pr-9 text-sm text-white placeholder-white/30 transition-colors focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/20"
              />
              <button
                type="button"
                tabIndex={searchOpen ? undefined : -1}
                onClick={hideSearch}
                aria-label="Close search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Pill handle — tap to reveal search */}
          <div
            aria-hidden={searchOpen}
            className={`overflow-hidden transition-all duration-300 ${
              searchOpen ? 'max-h-0 py-0 opacity-0' : 'max-h-9 py-1 opacity-100'
            }`}
          >
            <button
              type="button"
              onClick={focusSearch}
              aria-label="Reveal friend search"
              aria-expanded={searchOpen}
              aria-controls="friend-search-panel"
              className="group mx-auto flex h-7 w-12 items-center justify-center rounded-full transition-colors hover:bg-white/[0.03]"
            >
              <span className="block h-1 w-10 rounded-full bg-white/15 transition-colors group-hover:bg-white/25" />
            </button>
          </div>
        </div>

        <div
          ref={listRef}
          onWheel={handleWheel}
          onScroll={hideSearchIfIdle}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          className="flex-1 space-y-2 overflow-y-auto px-2 pt-3 pb-[calc(env(safe-area-inset-bottom)_+_6rem)] lg:pb-[calc(env(safe-area-inset-bottom)_+_0.75rem)]"
        >
          {friendsError && (
            <p className="mx-2 text-xs text-amber-400/70">
              Could not refresh friends — data may be stale.
            </p>
          )}

          {friends.length === 0 && (
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
                onClick={() => handleTapFriend(friend)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0f0f16]"
                aria-label={`Open conversation with ${friendDisplayName(friend)}`}
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
              {canMutate && confirmingUnfriendId !== friend.userId && (
                <button
                  type="button"
                  aria-label={`Remove friend ${friendDisplayName(friend)}`}
                  onClick={() => setConfirmingUnfriendId(friend.userId)}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-white/40 transition-colors hover:bg-red-500/15 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
                >
                  <UserMinus className="h-4 w-4" />
                </button>
              )}
              {canMutate && confirmingUnfriendId === friend.userId && (
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    aria-label={`Confirm remove ${friendDisplayName(friend)}`}
                    onClick={() => {
                      setConfirmingUnfriendId(null);
                      void handleUnfriend(friend.userId);
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
                  {canMutate && (
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
                  )}
                  {sendRequestError && (
                    <p className="mt-2 text-xs text-red-400">{sendRequestError}</p>
                  )}
                </>
              )}
            </div>
          )}

          {incomingRequests.length > 0 && (
            <div className="mx-2 pt-2">
              <p className="mb-2 px-1 text-xs font-medium uppercase tracking-[0.08em] text-white/35">
                Incoming requests
              </p>
              <div className="space-y-1">
                {incomingRequests.map((req) => (
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
                        onClick={() => void handleAcceptRequest(req.requestId)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-300 transition-colors hover:bg-emerald-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Decline request from ${req.displayName ?? req.argusId}`}
                        onClick={() => void handleDeclineRequest(req.requestId)}
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

          {outgoingRequests.length > 0 && (
            <div className="mx-2 pt-2">
              <p className="mb-2 px-1 text-xs font-medium uppercase tracking-[0.08em] text-white/35">
                Outgoing requests
              </p>
              <div className="space-y-1">
                {outgoingRequests.map((req) => (
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
                      onClick={() => void handleCancelRequest(req.requestId)}
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
    </div>
  );
}
