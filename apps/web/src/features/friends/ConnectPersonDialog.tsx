import { useRef, useState } from 'react';
import { Search, UserPlus, X } from 'lucide-react';
import { lookupUserByArgusId, type Friend, type UserLookupResult } from '../../lib/api';
import { dicebearAvatar } from '../../lib/dicebear';
import {
  Avatar,
  Button,
  EmptyState,
  IconButton,
  Modal,
  modalBackdropEnterMotion,
  modalBackdropExitMotion,
  modalPanelEnterMotion,
  modalPanelExitMotion,
} from '../ui';

const ARGUS_ID_RE = /^argus-[abcdefghjkmnpqrstuvwxyz23456789]{16}-[a-z]+$/;

interface ConnectPersonDialogProps {
  friends: Friend[];
  onSendFriendRequest: (argusId: string) => Promise<void>;
  onClose: () => void;
}

function userDisplayName(user: UserLookupResult): string {
  return user.displayName ?? user.argusId;
}

export function ConnectPersonDialog({
  friends,
  onSendFriendRequest,
  onClose,
}: ConnectPersonDialogProps) {
  const [argusId, setArgusId] = useState('');
  const [lookupResult, setLookupResult] = useState<UserLookupResult | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [sending, setSending] = useState(false);
  const [sentDisplayName, setSentDisplayName] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const inFlightLookup = useRef<string | null>(null);

  const handleClose = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, 220);
  };

  const handleLookup = () => {
    const id = argusId.trim();
    if (!id || looking || sending) return;
    setLookupError(null);
    setLookupResult(null);
    setSentDisplayName(null);
    if (!ARGUS_ID_RE.test(id)) {
      setLookupError('Invalid argus ID. Paste the exact ID from their profile.');
      return;
    }
    inFlightLookup.current = id;
    setLooking(true);
    lookupUserByArgusId(id)
      .then((result) => {
        if (inFlightLookup.current !== id) return;
        if (!result) {
          setLookupError('No user found with that argus-id.');
          return;
        }
        if (friends.some((friend) => friend.userId === result.userId)) {
          setLookupError('That person is already in your friends list.');
          return;
        }
        setLookupResult(result);
      })
      .catch(() => {
        if (inFlightLookup.current === id) {
          setLookupError('Lookup failed. Check the id and try again.');
        }
      })
      .finally(() => {
        if (inFlightLookup.current === id) setLooking(false);
      });
  };

  const handleSend = async () => {
    if (!lookupResult || sending) return;
    setSending(true);
    setLookupError(null);
    const displayName = userDisplayName(lookupResult);
    try {
      await onSendFriendRequest(lookupResult.argusId);
      setSentDisplayName(displayName);
      setLookupResult(null);
      setArgusId('');
    } catch {
      setLookupError('Could not send request. Try again in a moment.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      ariaLabel="Connect new person"
      onClose={handleClose}
      closeOnBackdrop
      className={`items-center justify-center bg-black/40 p-4 backdrop-blur-md ${
        closing ? modalBackdropExitMotion : modalBackdropEnterMotion
      }`}
      contentClassName={`w-full max-w-md rounded-3xl border border-white/5 bg-[#12121a] p-6 shadow-2xl shadow-black/50 ${
        closing ? modalPanelExitMotion : modalPanelEnterMotion
      }`}
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UserPlus className="h-5 w-5 text-purple-400" />
          <h2 className="text-lg font-semibold text-white">Connect new person</h2>
        </div>
        <IconButton onClick={handleClose} size="sm" aria-label="Close connect new person">
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
            onChange={(event) => {
              setArgusId(event.target.value);
              setLookupError(null);
              setLookupResult(null);
              setSentDisplayName(null);
              inFlightLookup.current = null;
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleLookup();
            }}
            placeholder="Paste argus-id..."
            aria-label="Person Argus ID"
            disabled={sending}
            className="w-full rounded-xl border border-white/5 bg-[#1a1a26] py-2.5 pl-10 pr-4 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-purple-500/50 disabled:opacity-50"
          />
        </div>
        <button
          type="button"
          onClick={handleLookup}
          disabled={looking || sending || !argusId.trim()}
          className="shrink-0 rounded-xl border border-white/10 px-4 text-sm text-white/60 transition-colors hover:border-purple-500/30 hover:text-white/90 disabled:opacity-50"
        >
          {looking ? '...' : 'Look up'}
        </button>
      </div>

      {lookupError && <p className="mb-3 text-xs text-red-400">{lookupError}</p>}
      {sentDisplayName && (
        <p className="mb-3 rounded-lg border border-emerald-400/20 bg-emerald-500/[0.08] px-3 py-2 text-sm font-medium text-emerald-200">
          Request sent to {sentDisplayName}
        </p>
      )}

      <div className="max-h-72 space-y-1 overflow-y-auto">
        {!lookupResult && !lookupError && !sentDisplayName && !looking && (
          <EmptyState title="Find a person" compact>
            Paste their Argus ID to look them up before sending a request.
          </EmptyState>
        )}
        {lookupResult && (
          <div className="rounded-xl border border-white/5 bg-[#1a1a26] p-3">
            <p className="mb-2 text-sm font-medium text-white/85">Send a friend request to:</p>
            <div className="flex items-center gap-3">
              <Avatar
                src={dicebearAvatar(lookupResult.userId)}
                name={userDisplayName(lookupResult)}
                size="md"
                shape="circle"
                className="shrink-0 ring-2 ring-white/5"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white/90">
                  {userDisplayName(lookupResult)}
                </p>
                <p className="truncate font-mono text-xs text-white/40">{lookupResult.argusId}</p>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                type="button"
                onClick={() => void handleSend()}
                disabled={sending}
                variant="subtle"
                size="md"
                className="flex-1"
              >
                <UserPlus className="h-4 w-4" />
                {sending ? 'Sending...' : 'Send request'}
              </Button>
              <IconButton
                onClick={() => setLookupResult(null)}
                size="md"
                aria-label="Cancel request"
                disabled={sending}
              >
                <X className="h-4 w-4" />
              </IconButton>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
