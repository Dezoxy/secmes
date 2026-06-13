import { useEffect, useState } from 'react';
import { Search, UserPlus, Users, X } from 'lucide-react';
import type { Conversation as MlsGroup } from '@argus/crypto';
import { listUsers, type UserSummary } from '../../lib/api';
import {
  GroupConversationManager,
  type GroupConversationSession,
  type PendingGroup,
} from '../../lib/conversations';
import type { MessagingDeps } from '../../lib/messaging';
import { dicebearAvatar } from '../../lib/dicebear';
import { contactDisplayName, contactSearchText } from './user-label';
import { VerifySecurity } from './VerifySecurity';
import { Avatar, Button, EmptyState, ErrorState, IconButton, LoadingState, Modal } from '../ui';
import { createSafeUiError, toSafeUiError, type SafeUiError } from '../../lib/safe-ui-error';

const MAX_GROUP_MEMBERS = 31; // 31 others + self = 32 total

type Phase =
  | { tag: 'picking' }
  | { tag: 'preparing' }
  | {
      tag: 'verifying';
      pending: PendingGroup;
      memberIndex: number;
      deviceIndex: number;
      users: UserSummary[];
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
  onAdded?: (addedUsers: UserSummary[]) => void;
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
  const [allUsers, setAllUsers] = useState<UserSummary[] | null>(null);
  const [loadError, setLoadError] = useState<SafeUiError | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [groupName, setGroupName] = useState('');
  const [phase, setPhase] = useState<Phase>({ tag: 'picking' });
  const [actionError, setActionError] = useState<SafeUiError | null>(null);

  useEffect(() => {
    let active = true;
    listUsers()
      .then((list) => {
        if (!active) return;
        const excluded = new Set<string>(
          [selfUserId, ...(existingMemberIds ?? [])].filter((id): id is string => id != null),
        );
        setAllUsers(list.filter((u) => !excluded.has(u.id)));
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
  }, [selfUserId, existingMemberIds]);

  const toggleUser = (userId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else if (next.size < MAX_GROUP_MEMBERS) {
        next.add(userId);
      }
      return next;
    });
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
          const addedUsers = pending.members
            .map((m) => allUsers?.find((u) => u.id === m.userId))
            .filter((u): u is UserSummary => u != null);
          onAdded?.(addedUsers);
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
    if (selected.size === 0) return;
    if (mode === 'create' && !groupName.trim()) return;
    setActionError(null);
    setPhase({ tag: 'preparing' });
    const name = mode === 'create' ? groupName.trim() : (existingGroupName ?? '');
    manager
      .prepare([...selected], name)
      .then((pending) => {
        setPhase({
          tag: 'verifying',
          pending,
          memberIndex: 0,
          deviceIndex: 0,
          users: allUsers ?? [],
        });
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
  // Multi-device members get one screen per device — a swapped key on ANY device is a MITM.
  if (phase.tag === 'verifying') {
    const { pending, memberIndex, deviceIndex, users } = phase;
    const member = pending.members[memberIndex]!;
    const user = users.find((u) => u.id === member.userId);
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
              users,
            });
          } else if (!isLastMember) {
            setPhase({
              tag: 'verifying',
              pending,
              memberIndex: memberIndex + 1,
              deviceIndex: 0,
              users,
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

  const shown = (allUsers ?? []).filter((u) =>
    contactSearchText(u).includes(filter.trim().toLowerCase()),
  );
  const busy = phase.tag === 'preparing' || phase.tag === 'confirming';
  const canContinue = selected.size > 0 && (mode === 'add' || groupName.trim().length > 0);
  const title = mode === 'create' ? 'New group' : 'Add members';

  return (
    <Modal
      ariaLabel={title}
      onClose={onClose}
      closeOnBackdrop
      className="items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      contentClassName="w-full max-w-md rounded-3xl border border-white/5 bg-[#12121a] p-6 shadow-2xl shadow-black/50"
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

      <div className="mb-4 max-h-64 space-y-1 overflow-y-auto">
        {allUsers === null && !loadError && (
          <LoadingState title="Loading contacts" compact className="mx-1 my-2" />
        )}
        {loadError && <ErrorState error={loadError} compact className="mx-1 my-2" />}
        {allUsers !== null && !loadError && shown.length === 0 && (
          <EmptyState
            title={allUsers.length === 0 ? 'No contacts available' : 'No matches'}
            compact
          >
            {allUsers.length === 0
              ? 'No other members are available to add.'
              : 'Try another search term.'}
          </EmptyState>
        )}
        {shown.map((u) => {
          const label = contactDisplayName(u);
          const isSelected = selected.has(u.id);
          const atMax = selected.size >= MAX_GROUP_MEMBERS && !isSelected;
          return (
            <button
              key={u.id}
              type="button"
              disabled={busy || atMax}
              onClick={() => toggleUser(u.id)}
              className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors disabled:opacity-50 ${
                isSelected
                  ? 'border-purple-500/40 bg-purple-500/10'
                  : 'border-transparent hover:bg-[#1a1a26]'
              }`}
            >
              <Avatar
                src={dicebearAvatar(u.id)}
                name={label}
                size="md"
                shape="circle"
                className="shrink-0 ring-2 ring-white/5"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white/90">{label}</p>
                <p className="truncate text-xs text-white/60">Pseudonymous member</p>
              </div>
              <div
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                  isSelected ? 'border-purple-400 bg-purple-500' : 'border-white/20'
                }`}
              >
                {isSelected && (
                  <svg viewBox="0 0 10 8" fill="none" className="h-2.5 w-2.5">
                    <path
                      d="M1 4l3 3L9 1"
                      stroke="white"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-white/40">
          {selected.size}/{MAX_GROUP_MEMBERS} selected
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
