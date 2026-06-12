import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Mail, Trash2, Users } from 'lucide-react';
import {
  createInvite,
  listInvites,
  listMembers,
  revokeInvite,
  revokeMember,
  setMemberRole,
  type InviteSummary,
  type MemberSummary,
} from '../../lib/api';
import { Button, StateBlock } from '../ui';

interface TeamSettingsProps {
  currentUserId: string;
}

function MemberRow({
  member,
  currentUserId,
  onRoleToggle,
  onRevoke,
}: {
  member: MemberSummary;
  currentUserId: string;
  onRoleToggle: (userId: string, newRole: 'admin' | 'member') => Promise<void>;
  onRevoke: (userId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const isSelf = member.userId === currentUserId;

  const handleRoleToggle = async () => {
    setBusy(true);
    try {
      await onRoleToggle(member.userId, member.role === 'admin' ? 'member' : 'admin');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-white">
          {member.displayName ?? member.email}
          {isSelf && <span className="ml-2 text-xs text-white/40">(you)</span>}
        </p>
        {member.displayName && <p className="truncate text-xs text-white/50">{member.email}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => void handleRoleToggle()}
          disabled={busy || isSelf}
          title={member.role === 'admin' ? 'Demote to member' : 'Promote to admin'}
          className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            member.role === 'admin'
              ? 'border-purple-400/30 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20'
              : 'border-white/10 bg-white/[0.04] text-white/60 hover:border-purple-400/30 hover:text-purple-300'
          }`}
        >
          {member.role}
        </button>
        {!isSelf && (
          <button
            type="button"
            onClick={() => onRevoke(member.userId)}
            title="Remove member"
            className="rounded-lg p-1.5 text-white/30 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function InviteRow({
  invite,
  onRevoke,
}: {
  invite: InviteSummary;
  onRevoke: (inviteId: string) => void;
}) {
  const expiresAt = new Date(invite.expiresAt);
  const isExpired = expiresAt < new Date();

  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
      <Mail className="h-4 w-4 shrink-0 text-white/30" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-white/80">{invite.inviteeEmail ?? 'Open invite'}</p>
        <p className="text-xs text-white/40">
          {isExpired ? 'Expired' : `Expires ${expiresAt.toLocaleDateString()}`}
        </p>
      </div>
      <button
        type="button"
        onClick={() => onRevoke(invite.id)}
        title="Revoke invite"
        className="rounded-lg p-1.5 text-white/30 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function CreateInviteForm({ onCreated }: { onCreated: (token: string) => void }) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await createInvite(email.trim() || undefined);
      setEmail('');
      setOpen(false);
      onCreated(result.token);
    } catch {
      setError('Could not create invite. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (!open) {
    return (
      <Button variant="subtle" size="sm" onClick={() => setOpen(true)}>
        Create invite
      </Button>
    );
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-2">
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="invitee@example.com (optional)"
        autoFocus
        className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white placeholder-white/30 outline-none focus:border-purple-500/60 focus:ring-1 focus:ring-purple-500/30"
      />
      {error && <p className="text-xs text-rose-300">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={loading} loadingLabel="Creating…">
          Create
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function CopyInviteLink({ token, onDismiss }: { token: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const link = `${typeof window !== 'undefined' ? window.location.origin : ''}/invite#${token}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-purple-400/20 bg-purple-500/[0.06] p-3">
      <p className="text-xs font-medium text-purple-300">Invite link created</p>
      <p className="break-all font-mono text-xs text-white/60">{link}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="subtle" onClick={() => void handleCopy()}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied!' : 'Copy link'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

export function TeamSettings({ currentUserId }: TeamSettingsProps) {
  const [members, setMembers] = useState<MemberSummary[] | null>(null);
  const [invites, setInvites] = useState<InviteSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingInviteToken, setPendingInviteToken] = useState<string | null>(null);
  const [confirmRevokeUserId, setConfirmRevokeUserId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, i] = await Promise.all([listMembers(), listInvites()]);
      setMembers(m);
      setInvites(i);
    } catch {
      setError('Could not load team data.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRoleToggle = async (userId: string, newRole: 'admin' | 'member') => {
    try {
      await setMemberRole(userId, newRole);
      setError(null);
      setMembers(
        (prev) => prev?.map((m) => (m.userId === userId ? { ...m, role: newRole } : m)) ?? null,
      );
    } catch {
      setError('Could not change role. You may be demoting the last admin.');
    }
  };

  const handleRevokeMember = async (userId: string) => {
    try {
      await revokeMember(userId);
      setError(null);
      setMembers((prev) => prev?.filter((m) => m.userId !== userId) ?? null);
    } catch {
      setError('Could not remove member.');
    } finally {
      setConfirmRevokeUserId(null);
    }
  };

  const handleRevokeInvite = async (inviteId: string) => {
    try {
      await revokeInvite(inviteId);
      setError(null);
      setInvites((prev) => prev?.filter((i) => i.id !== inviteId) ?? null);
    } catch {
      setError('Could not revoke invite.');
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <StateBlock variant="error" title="Error">
          {error}
        </StateBlock>
      )}

      {pendingInviteToken && (
        <CopyInviteLink token={pendingInviteToken} onDismiss={() => setPendingInviteToken(null)} />
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-white/50" />
            <h4 className="text-sm font-medium text-white/70">
              Members
              {members && <span className="ml-2 text-white/40">({members.length})</span>}
            </h4>
          </div>
        </div>

        {members === null && !error && <div className="text-sm text-white/40">Loading…</div>}

        {members?.map((member) =>
          confirmRevokeUserId === member.userId ? (
            <div
              key={member.userId}
              className="flex items-center gap-3 rounded-xl border border-rose-400/20 bg-rose-500/[0.06] px-4 py-3"
            >
              <p className="flex-1 text-sm text-rose-200">
                Remove <strong>{member.displayName ?? member.email}</strong>?
              </p>
              <Button
                size="sm"
                variant="danger"
                onClick={() => void handleRevokeMember(member.userId)}
              >
                Remove
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRevokeUserId(null)}>
                Cancel
              </Button>
            </div>
          ) : (
            <MemberRow
              key={member.userId}
              member={member}
              currentUserId={currentUserId}
              onRoleToggle={handleRoleToggle}
              onRevoke={(id) => setConfirmRevokeUserId(id)}
            />
          ),
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-white/70">
            Pending invites
            {invites && invites.length > 0 && (
              <span className="ml-2 text-white/40">({invites.length})</span>
            )}
          </h4>
        </div>

        {invites?.map((invite) => (
          <InviteRow
            key={invite.id}
            invite={invite}
            onRevoke={(id) => void handleRevokeInvite(id)}
          />
        ))}

        {invites?.length === 0 && <p className="text-xs text-white/40">No pending invites.</p>}

        <CreateInviteForm
          onCreated={(token) => {
            setPendingInviteToken(token);
            void load();
          }}
        />
      </div>
    </div>
  );
}
