import { useEffect, useState } from 'react';

import { Loader2, Search, UserPlus, X } from 'lucide-react';

import { listUsers, type UserSummary } from '../../lib/api';
import {
  ConversationManager,
  type ConversationSession,
  type PendingConversation,
} from '../../lib/conversations';
import { generatedAvatar } from './seed';
import { contactDisplayName, contactSearchText } from './user-label';
import { VerifySecurity } from './VerifySecurity';
import { Avatar, IconButton, Modal } from '../ui';

interface StartConversationProps {
  manager: ConversationManager;
  /** The signed-in user's id — excluded from the picker (you can't start a 1:1 with yourself). */
  selfUserId?: string;
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
  onStarted,
  onClose,
}: StartConversationProps) {
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [peer, setPeer] = useState<UserSummary | null>(null);
  const [pending, setPending] = useState<PendingConversation | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listUsers()
      .then((list) => {
        if (active) setUsers(list.filter((u) => u.id !== selfUserId));
      })
      .catch(() => {
        if (active) setLoadError('could not load contacts');
      });
    return () => {
      active = false;
    };
  }, [selfUserId]);

  // Phase 1: claim the peer's KeyPackage + derive the safety number. Trusts nothing yet.
  const pick = (u: UserSummary): void => {
    setPeer(u);
    setBusy(true);
    setActionError(null);
    manager
      .prepare(u.id)
      .then((p) => setPending(p))
      .catch((e: unknown) => {
        setActionError(e instanceof Error ? e.message : 'could not reach this contact');
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
        setActionError(e instanceof Error ? e.message : 'could not start the conversation');
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
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search people…"
          className="w-full rounded-xl border border-white/5 bg-[#1a1a26] py-2.5 pl-10 pr-4 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-purple-500/50"
        />
      </div>

      {busy && <p className="px-1 pb-2 text-xs text-white/40">Claiming a one-time key…</p>}
      {actionError && <p className="px-1 pb-2 text-xs text-red-400/80">{actionError}</p>}

      <div className="max-h-72 space-y-1 overflow-y-auto">
        {users === null && !loadError && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-white/40">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading contacts…
          </div>
        )}
        {loadError && <p className="py-8 text-center text-sm text-red-400/80">{loadError}</p>}
        {users !== null && !loadError && shown.length === 0 && (
          <p className="py-8 text-center text-sm text-white/40">
            {users.length === 0 ? 'No other members in your workspace yet.' : 'No matches.'}
          </p>
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
                src={generatedAvatar(`${label} ${u.id}`)}
                name={label}
                size="md"
                shape="circle"
                className="shrink-0 ring-2 ring-white/5"
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white/90">{label}</p>
                <p className="truncate text-xs text-white/40">Pseudonymous member</p>
              </div>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
