import { useEffect, useState } from 'react';

import { Search, UserPlus, X } from 'lucide-react';

import { lookupUserByArgusId, type UserLookupResult } from '../../lib/api';
import {
  ConversationManager,
  type ConversationSession,
  type PendingConversation,
} from '../../lib/conversations';
import { dicebearAvatar } from '../../lib/dicebear';
import { contactDisplayName } from './user-label';
import { VerifySecurity } from './VerifySecurity';
import {
  Avatar,
  EmptyState,
  ErrorState,
  IconButton,
  LoadingState,
  Modal,
  modalBackdropEnterMotion,
  modalPanelEnterMotion,
} from '../ui';
import { toSafeUiError, type SafeUiError } from '../../lib/safe-ui-error';

interface StartConversationProps {
  manager: ConversationManager;
  /** The signed-in user's id — excluded from the picker (you can't start a 1:1 with yourself). */
  selfUserId?: string;
  /**
   * Look up an already-existing direct conversation with this peer (by their user id). When it returns an
   * id, picking the contact OPENS that conversation instead of starting a new one.
   */
  existingConversationWith: (peerUserId: string) => string | null;
  /** Open an existing conversation (the dedup path) — select it and close the picker. */
  onOpenExisting: (conversationId: string) => void;
  onStarted: (session: ConversationSession, peer: UserLookupResult) => void;
  onClose: () => void;
  /** When set, pre-populates the argus-id input and fires the lookup automatically on mount. */
  prefillArgusId?: string;
}

const CARD =
  'w-full max-w-md rounded-3xl border border-white/5 bg-[#12121a] p-6 shadow-2xl shadow-black/50';

/**
 * Start a 1:1: look up a peer by argus-id, then verify the safety number before the conversation is
 * created. The flow is gated by ConversationManager: prepare() only claims a one-time KeyPackage and
 * derives the number; confirm() runs ONLY after the user confirms the number out-of-band.
 */
export function StartConversation({
  manager,
  selfUserId,
  existingConversationWith,
  onOpenExisting,
  onStarted,
  onClose,
  prefillArgusId,
}: StartConversationProps) {
  const [argusId, setArgusId] = useState('');
  const [lookupResult, setLookupResult] = useState<UserLookupResult | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [peer, setPeer] = useState<UserLookupResult | null>(null);
  const [pending, setPending] = useState<PendingConversation | null>(null);
  // -1 = showing primary SN; 0+ = showing secondary device SN at that index.
  const [secondaryStep, setSecondaryStep] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<SafeUiError | null>(null);

  // When opened from the friends panel with a pre-known argus-id, auto-populate and fire the lookup.
  useEffect(() => {
    if (!prefillArgusId) return;
    setArgusId(prefillArgusId);
    lookupUserByArgusId(prefillArgusId)
      .then((result) => {
        if (result) setLookupResult(result);
        else setLookupError('No user found with that argus-id.');
      })
      .catch(() => setLookupError('Lookup failed. Check the id and try again.'));
  }, [prefillArgusId]);

  const handleLookup = (): void => {
    const id = argusId.trim();
    if (!id || looking) return;
    setLookupError(null);
    setLookupResult(null);
    setLooking(true);
    lookupUserByArgusId(id)
      .then((result) => {
        if (!result) {
          setLookupError('No user found with that argus-id.');
          return;
        }
        if (result.userId === selfUserId) {
          setLookupError("That's your own account.");
          return;
        }
        setLookupResult(result);
      })
      .catch(() => setLookupError('Lookup failed. Check the id and try again.'))
      .finally(() => setLooking(false));
  };

  // Phase 1: claim the peer's KeyPackage + derive the safety number. Trusts nothing yet.
  const pick = (u: UserLookupResult): void => {
    const existing = existingConversationWith(u.userId);
    if (existing) {
      onOpenExisting(existing);
      return;
    }
    setPeer(u);
    setSecondaryStep(-1);
    setBusy(true);
    setActionError(null);
    manager
      .prepare(u.userId)
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
    const peerName = contactDisplayName(peer);
    if (secondaryStep >= 0 && secondaryStep < pending.peerSecondaryDevices.length) {
      const secDev = pending.peerSecondaryDevices[secondaryStep]!;
      const total = pending.peerSecondaryDevices.length + 1;
      return (
        <VerifySecurity
          mode="live"
          peerName={`${peerName} (device ${String(secondaryStep + 2)} of ${String(total)})`}
          safetyNumber={secDev.safetyNumber}
          verified={false}
          error={actionError}
          onVerifiedChange={(v) => {
            if (!v) return;
            if (secondaryStep + 1 >= pending.peerSecondaryDevices.length) {
              confirm();
            } else {
              setSecondaryStep(secondaryStep + 1);
            }
          }}
          onClose={() => {
            setSecondaryStep(-1);
            setPending(null);
            setPeer(null);
            setActionError(null);
          }}
        />
      );
    }
    return (
      <VerifySecurity
        mode="live"
        peerName={peerName}
        safetyNumber={pending.safetyNumber}
        verified={false}
        error={actionError}
        onVerifiedChange={(v) => {
          if (!v) return;
          if (pending.peerSecondaryDevices.length === 0) {
            confirm();
          } else {
            setSecondaryStep(0);
          }
        }}
        onClose={() => {
          setPending(null);
          setPeer(null);
          setActionError(null);
        }}
      />
    );
  }

  return (
    <Modal
      ariaLabel="New conversation"
      onClose={onClose}
      closeOnBackdrop
      className={`items-center justify-center bg-black/40 p-4 backdrop-blur-md ${modalBackdropEnterMotion}`}
      contentClassName={`${CARD} ${modalPanelEnterMotion}`}
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

      <div className="mb-3 flex gap-2">
        <div className="relative flex-1">
          <Search
            aria-hidden="true"
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30"
          />
          <input
            type="text"
            value={argusId}
            onChange={(e) => {
              setArgusId(e.target.value);
              setLookupResult(null);
              setLookupError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleLookup();
            }}
            placeholder="Paste argus-id…"
            className="w-full rounded-xl border border-white/5 bg-[#1a1a26] py-2.5 pl-10 pr-4 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-purple-500/50"
          />
        </div>
        <button
          type="button"
          onClick={handleLookup}
          disabled={looking || !argusId.trim()}
          className="shrink-0 rounded-xl bg-purple-500 px-4 text-sm font-medium text-white transition-colors hover:bg-purple-400 disabled:opacity-50"
        >
          {looking ? '…' : 'Look up'}
        </button>
      </div>

      {lookupError && <p className="mb-3 text-xs text-red-400">{lookupError}</p>}

      {busy && (
        <LoadingState title="Claiming key" compact className="mb-3">
          Claiming a one-time key.
        </LoadingState>
      )}
      {actionError && <ErrorState error={actionError} compact className="mb-3" />}

      <div className="max-h-72 space-y-1 overflow-y-auto">
        {!lookupResult && !lookupError && !looking && (
          <EmptyState title="Find a contact" compact>
            Paste the person's argus-id and press Look up.
          </EmptyState>
        )}
        {lookupResult &&
          (() => {
            const label = contactDisplayName(lookupResult);
            return (
              <button
                type="button"
                disabled={busy}
                onClick={() => pick(lookupResult)}
                className="flex w-full items-center gap-3 rounded-xl border border-transparent p-3 text-left transition-colors hover:bg-[#1a1a26] disabled:opacity-50"
              >
                <Avatar
                  src={dicebearAvatar(lookupResult.userId)}
                  name={label}
                  size="md"
                  shape="circle"
                  className="shrink-0 ring-2 ring-white/5"
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white/90">{label}</p>
                  <p className="truncate text-xs text-white/40 font-mono">{lookupResult.argusId}</p>
                </div>
              </button>
            );
          })()}
      </div>
    </Modal>
  );
}
