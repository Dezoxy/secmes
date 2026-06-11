import { useEffect, useState } from 'react';

import { Search, UserPlus, X } from 'lucide-react';

import { listUsers, type UserSummary } from '../../lib/api';
import {
  ConversationManager,
  type ConversationSession,
  type PendingConversation,
} from '../../lib/conversations';
import { dicebearAvatar } from '../../lib/dicebear';
import { contactDisplayName, contactSearchText } from './user-label';
import { VerifySecurity } from './VerifySecurity';
import { Avatar, EmptyState, ErrorState, IconButton, LoadingState, Modal } from '../ui';
import { createSafeUiError, toSafeUiError, type SafeUiError } from '../../lib/safe-ui-error';

interface StartConversationProps {
  manager: ConversationManager;
  /** The signed-in user's id — excluded from the picker (you can't start a 1:1 with yourself). */
  selfUserId?: string;
  /**
   * Look up an already-existing direct conversation with this peer (by their user id). When it returns an
   * id, picking the contact OPENS that conversation instead of starting a new one — a 1:1 is unique per
   * peer, and skipping `prepare()` also avoids burning one of the peer's one-time KeyPackages on a dupe.
   */
  existingConversationWith: (peerUserId: string) => string | null;
  /** Open an existing conversation (the dedup path) — select it and close the picker. */
  onOpenExisting: (conversationId: string) => void;
  onStarted: (session: ConversationSession, peer: UserSummary) => void;
  onClose: () => void;
}

const CARD =
  'w-full max-w-md rounded-3xl border border-white/5 bg-[#12121a] p-6 shadow-2xl shadow-black/50';

/**
 * Start a 1:1: pick a tenant member, then verify the safety number (#20) BEFORE the conversation is
 * created. The flow is gated by `ConversationManager`: `prepare()` only claims a one-time KeyPackage and
 * derives the number; `confirm()` (add + create + deliver) runs ONLY after the user confirms the number
 * out-of-band — so a swapped key (a malicious server / MITM) is caught before any group is formed.
 */
export function StartConversation({
  manager,
  selfUserId,
  existingConversationWith,
  onOpenExisting,
  onStarted,
  onClose,
}: StartConversationProps) {
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [loadError, setLoadError] = useState<SafeUiError | null>(null);
  const [filter, setFilter] = useState('');
  const [peer, setPeer] = useState<UserSummary | null>(null);
  const [pending, setPending] = useState<PendingConversation | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<SafeUiError | null>(null);

  useEffect(() => {
    let active = true;
    listUsers()
      .then((list) => {
        if (active) setUsers(list.filter((u) => u.id !== selfUserId));
      })
      .catch(() => {
        if (active) {
          setLoadError(
            createSafeUiError({
              title: 'Contacts unavailable',
              message: 'Contacts could not be loaded. Try again in a moment.',
              kind: 'network',
            }),
          );
        }
      });
    return () => {
      active = false;
    };
  }, [selfUserId]);

  // Phase 1: claim the peer's KeyPackage + derive the safety number. Trusts nothing yet.
  const pick = (u: UserSummary): void => {
    // A 1:1 is unique per peer: if a conversation with this contact already exists, OPEN it — don't mint
    // another (which would also burn one of their one-time KeyPackages on a duplicate).
    const existing = existingConversationWith(u.id);
    if (existing) {
      onOpenExisting(existing);
      return;
    }
    setPeer(u);
    setBusy(true);
    setActionError(null);
    manager
      .prepare(u.id)
      .then((p) => setPending(p))
      .catch((e: unknown) => {
        setActionError(
          toSafeUiError(e, {
            title: 'Contact unavailable',
            message: 'Could not reach this contact. Try again in a moment.',
          }),
        );
        setPeer(null);
      })
      .finally(() => setBusy(false));
  };

  // Phase 2: ONLY after the user confirms the number out-of-band — add + create + deliver.
  const confirm = (): void => {
    if (!pending || !peer || busy) return;
    setBusy(true);
    setActionError(null);
    manager
      .confirm(pending)
      .then((session) => onStarted(session, peer))
      .catch((e: unknown) => {
        setActionError(
          toSafeUiError(e, {
            title: 'Conversation not started',
            message: 'Could not start the conversation. Try again in a moment.',
          }),
        );
        setBusy(false);
      });
  };

  if (pending && peer) {
    return (
      <VerifySecurity
        mode="live"
        peerName={contactDisplayName(peer)}
        safetyNumber={pending.safetyNumber}
        verified={false}
        error={actionError}
        onVerifiedChange={(v) => {
          if (v) confirm();
        }}
        onClose={() => {
          setPending(null);
          setPeer(null);
          setActionError(null);
        }}
      />
    );
  }

  const shown = (users ?? []).filter((u) =>
    contactSearchText(u).includes(filter.trim().toLowerCase()),
  );

  return (
    <Modal
      ariaLabel="New conversation"
      onClose={onClose}
      closeOnBackdrop
      className="items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      contentClassName={CARD}
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UserPlus className="h-5 w-5 text-purple-400" />
          <h2 className="text-lg font-semibold text-white">New conversation</h2>
        </div>
        <IconButton onClick={onClose} size="sm" aria-label="Close new conversation">
          <X className="h-5 w-5" />
        </IconButton>
      </div>

      <div className="relative mb-3">
        <Search
          aria-hidden="true"
          className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30"
        />
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search people…"
          className="w-full rounded-xl border border-white/5 bg-[#1a1a26] py-2.5 pl-10 pr-4 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-purple-500/50"
        />
      </div>

      {busy && (
        <LoadingState title="Claiming key" compact className="mb-3">
          Claiming a one-time key.
        </LoadingState>
      )}
      {actionError && <ErrorState error={actionError} compact className="mb-3" />}

      <div className="max-h-72 space-y-1 overflow-y-auto">
        {users === null && !loadError && (
          <LoadingState title="Loading contacts" compact className="mx-1 my-2" />
        )}
        {loadError && <ErrorState error={loadError} compact className="mx-1 my-2" />}
        {users !== null && !loadError && shown.length === 0 && (
          <EmptyState title={users.length === 0 ? 'No contacts yet' : 'No matches'} compact>
            {users.length === 0
              ? 'No other members are available in this workspace yet.'
              : 'Try another search term.'}
          </EmptyState>
        )}
        {shown.map((u) => {
          const label = contactDisplayName(u);
          return (
            <button
              key={u.id}
              type="button"
              disabled={busy}
              onClick={() => pick(u)}
              className="flex w-full items-center gap-3 rounded-xl border border-transparent p-3 text-left transition-colors hover:bg-[#1a1a26] disabled:opacity-50"
            >
              <Avatar
                src={dicebearAvatar(u.id)}
                name={label}
                size="md"
                shape="circle"
                className="shrink-0 ring-2 ring-white/5"
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white/90">{label}</p>
                <p className="truncate text-xs text-white/60">Pseudonymous member</p>
              </div>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
