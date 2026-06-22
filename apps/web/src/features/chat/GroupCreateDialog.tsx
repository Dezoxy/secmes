import { useState } from 'react';
import { Search, UserPlus, Users, X } from 'lucide-react';
import type { Conversation as MlsGroup } from '@argus/crypto';
import { lookupUserByArgusId, type UserLookupResult } from '../../lib/api';
import {
  GroupConversationManager,
  type GroupConversationSession,
  type PendingGroup,
} from '../../lib/conversations';
import type { MessagingDeps } from '../../lib/messaging';
import { dicebearAvatar } from '../../lib/dicebear';
import { contactDisplayName } from './user-label';
import { VerifySecurity } from './VerifySecurity';
import {
  Avatar,
  Button,
  ErrorState,
  IconButton,
  LoadingState,
  Modal,
  modalBackdropEnterMotion,
  modalPanelEnterMotion,
} from '../ui';
import { toSafeUiError, type SafeUiError } from '../../lib/safe-ui-error';

const MAX_GROUP_MEMBERS = 31; // 31 others + self = 32 total

type Phase =
  | { tag: 'picking' }
  | { tag: 'preparing' }
  | {
      tag: 'verifying';
      pending: PendingGroup;
      memberIndex: number;
      deviceIndex: number;
      selected: UserLookupResult[];
    }
  | { tag: 'confirming' };

interface GroupCreateDialogProps {
  mode: 'create' | 'add';
  manager: GroupConversationManager;
  deps: MessagingDeps;
  selfUserId?: string;
  // 'add' mode only — the existing live MLS group and its current member ids (excluded from the picker).
  conversationId?: string;
  existingConversation?: MlsGroup;
  existingMemberIds?: Set<string>;
  existingGroupName?: string;
  // Callbacks.
  onCreated?: (session: GroupConversationSession) => void;
  onAdded?: (addedUsers: UserLookupResult[]) => void;
  onClose: () => void;
}

export function GroupCreateDialog({
  mode,
  manager,
  deps,
  selfUserId,
  conversationId,
  existingConversation,
  existingMemberIds,
  existingGroupName,
  onCreated,
  onAdded,
  onClose,
}: GroupCreateDialogProps) {
  const [argusId, setArgusId] = useState('');
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [selected, setSelected] = useState<UserLookupResult[]>([]);
  const [groupName, setGroupName] = useState('');
  const [phase, setPhase] = useState<Phase>({ tag: 'picking' });
  const [actionError, setActionError] = useState<SafeUiError | null>(null);

  const excluded = new Set<string>(
    [selfUserId, ...(existingMemberIds ?? [])].filter((id): id is string => id != null),
  );

  const handleLookup = (): void => {
    const id = argusId.trim();
    if (!id || looking) return;
    setLookupError(null);
    setLooking(true);
    lookupUserByArgusId(id)
      .then((result) => {
        if (!result) {
          setLookupError('No user found with that argus-id.');
          return;
        }
        if (excluded.has(result.userId)) {
          setLookupError('That user is already a member.');
          return;
        }
        if (selected.some((u) => u.userId === result.userId)) {
          setLookupError('Already added.');
          return;
        }
        if (selected.length >= MAX_GROUP_MEMBERS) {
          setLookupError(`Maximum ${MAX_GROUP_MEMBERS} members reached.`);
          return;
        }
        setSelected((prev) => [...prev, result]);
        setArgusId('');
      })
      .catch(() => setLookupError('Lookup failed. Check the id and try again.'))
      .finally(() => setLooking(false));
  };

  const removeSelected = (userId: string): void => {
    setSelected((prev) => prev.filter((u) => u.userId !== userId));
  };

  const handleConfirm = (pending: PendingGroup): void => {
    setActionError(null);
    setPhase({ tag: 'confirming' });
    if (mode === 'create') {
      manager
        .confirmCreate(pending, deps)
        .then((session) => {
          onCreated?.(session);
          onClose();
        })
        .catch((e: unknown) => {
          setActionError(
            toSafeUiError(e, {
              title: 'Group creation failed',
              message: 'Could not finish creating the group. Try again.',
            }),
          );
          setPhase({ tag: 'picking' });
        });
    } else {
      manager
        .confirmAdd(conversationId!, existingConversation!, pending, deps)
        .then(() => {
          onAdded?.(selected);
          onClose();
        })
        .catch((e: unknown) => {
          setActionError(
            toSafeUiError(e, {
              title: 'Failed to add members',
              message: 'Could not add the selected members. Try again.',
            }),
          );
          setPhase({ tag: 'picking' });
        });
    }
  };

  const handleContinue = (): void => {
    if (selected.length === 0) return;
    if (mode === 'create' && !groupName.trim()) return;
    setActionError(null);
    setPhase({ tag: 'preparing' });
    const name = mode === 'create' ? groupName.trim() : (existingGroupName ?? '');
    manager
      .prepare(
        selected.map((u) => u.userId),
        name,
      )
      .then((pending) => {
        setPhase({ tag: 'verifying', pending, memberIndex: 0, deviceIndex: 0, selected });
      })
      .catch((e: unknown) => {
        setActionError(
          toSafeUiError(e, {
            title: 'Key claim failed',
            message: 'Could not claim keys for one or more members. Try again.',
          }),
        );
        setPhase({ tag: 'picking' });
      });
  };

  // Verifying phase: render VerifySecurity for each (member, device) pair sequentially.
  if (phase.tag === 'verifying') {
    const { pending, memberIndex, deviceIndex, selected: sel } = phase;
    const member = pending.members[memberIndex]!;
    const user = sel.find((u) => u.userId === member.userId);
    const name = user ? contactDisplayName(user) : member.userId;
    const totalMembers = pending.members.length;
    const totalDevices = member.allDevices.length;
    const memberSuffix = totalMembers > 1 ? ` (${memberIndex + 1} of ${totalMembers})` : '';
    const deviceSuffix = totalDevices > 1 ? ` — device ${deviceIndex + 1} of ${totalDevices}` : '';
    const peerName = `${name}${memberSuffix}${deviceSuffix}`;
    const isLastDevice = deviceIndex === totalDevices - 1;
    const isLastMember = memberIndex === totalMembers - 1;
    const isLast = isLastDevice && isLastMember;
    return (
      <VerifySecurity
        mode="live"
        peerName={peerName}
        safetyNumber={member.safetyNumbers[deviceIndex]!}
        verified={false}
        error={isLast ? actionError : null}
        onVerifiedChange={(v) => {
          if (!v) return;
          if (!isLastDevice) {
            setPhase({
              tag: 'verifying',
              pending,
              memberIndex,
              deviceIndex: deviceIndex + 1,
              selected: sel,
            });
          } else if (!isLastMember) {
            setPhase({
              tag: 'verifying',
              pending,
              memberIndex: memberIndex + 1,
              deviceIndex: 0,
              selected: sel,
            });
          } else {
            handleConfirm(pending);
          }
        }}
        onClose={() => {
          setActionError(null);
          setPhase({ tag: 'picking' });
        }}
      />
    );
  }

  const busy = phase.tag === 'preparing' || phase.tag === 'confirming';
  const canContinue = selected.length > 0 && (mode === 'add' || groupName.trim().length > 0);
  const title = mode === 'create' ? 'New group' : 'Add members';

  return (
    <Modal
      ariaLabel={title}
      onClose={onClose}
      closeOnBackdrop
      className={`items-center justify-center bg-black/40 p-4 backdrop-blur-md ${modalBackdropEnterMotion}`}
      contentClassName={`w-full max-w-md rounded-3xl border border-white/5 bg-[#12121a] p-6 shadow-2xl shadow-black/50 ${modalPanelEnterMotion}`}
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {mode === 'create' ? (
            <Users className="h-5 w-5 text-purple-400" />
          ) : (
            <UserPlus className="h-5 w-5 text-purple-400" />
          )}
          <h2 className="text-lg font-semibold text-white">{title}</h2>
        </div>
        <IconButton onClick={onClose} size="sm" aria-label={`Close ${title}`}>
          <X className="h-5 w-5" />
        </IconButton>
      </div>

      {mode === 'create' && (
        <div className="mb-3">
          <input
            type="text"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="Group name…"
            maxLength={100}
            className="w-full rounded-xl border border-white/5 bg-[#1a1a26] px-4 py-2.5 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-purple-500/50"
          />
        </div>
      )}

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
              setLookupError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleLookup();
            }}
            placeholder="Add by argus-id…"
            disabled={busy}
            className="w-full rounded-xl border border-white/5 bg-[#1a1a26] py-2.5 pl-10 pr-4 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-purple-500/50 disabled:opacity-50"
          />
        </div>
        <button
          type="button"
          onClick={handleLookup}
          disabled={busy || looking || !argusId.trim()}
          className="shrink-0 rounded-xl border border-white/10 px-4 text-sm text-white/60 transition-colors hover:border-purple-500/30 hover:text-white/90 disabled:opacity-50"
        >
          {looking ? '…' : 'Add'}
        </button>
      </div>

      {lookupError && <p className="mb-2 text-xs text-red-400">{lookupError}</p>}

      {busy && (
        <LoadingState
          title={phase.tag === 'preparing' ? 'Claiming keys' : 'Setting up group'}
          compact
          className="mb-3"
        >
          {phase.tag === 'preparing'
            ? 'Claiming one-time keys for each member…'
            : 'Finishing group setup…'}
        </LoadingState>
      )}
      {actionError && <ErrorState error={actionError} compact className="mb-3" />}

      {selected.length > 0 && (
        <div className="mb-4 max-h-48 space-y-1 overflow-y-auto">
          {selected.map((u) => {
            const label = contactDisplayName(u);
            return (
              <div
                key={u.userId}
                className="flex items-center gap-3 rounded-xl border border-white/5 bg-[#1a1a26] p-3"
              >
                <Avatar
                  src={dicebearAvatar(u.userId)}
                  name={label}
                  size="md"
                  shape="circle"
                  className="shrink-0 ring-2 ring-white/5"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white/90">{label}</p>
                  <p className="truncate text-xs text-white/40 font-mono">{u.argusId}</p>
                </div>
                <IconButton
                  onClick={() => removeSelected(u.userId)}
                  size="sm"
                  aria-label={`Remove ${label}`}
                  disabled={busy}
                >
                  <X className="h-4 w-4" />
                </IconButton>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-white/40">
          {selected.length}/{MAX_GROUP_MEMBERS} added
        </p>
        <Button
          onClick={handleContinue}
          disabled={!canContinue || busy}
          size="lg"
          className="shadow-purple-500/25 disabled:bg-purple-500/50 disabled:shadow-none"
        >
          Continue
        </Button>
      </div>
    </Modal>
  );
}
