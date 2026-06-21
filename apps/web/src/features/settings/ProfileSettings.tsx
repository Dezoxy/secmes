import { useState } from 'react';
import { Check, Copy, Image, Sparkles } from 'lucide-react';
import { Avatar, Button, ErrorState, StateBlock } from '../ui';
import { createSafeUiError } from '../../lib/safe-ui-error';

export interface AnonymousProfile {
  id: string;
  username: string;
  avatar: string;
}

interface ProfileSettingsProps {
  profile: AnonymousProfile;
  displayName: string | null;
  avatar: string;
  profileError: string | null;
}

const INPUT =
  'w-full rounded-xl border border-white/5 bg-[#1a1a26] px-4 py-2.5 text-sm text-white placeholder-white/30 transition-all focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/20';
const SUBTLE_BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm font-medium text-white/70 transition-colors hover:border-purple-500/40 hover:text-white';

export function ProfileSettings({
  profile,
  displayName,
  avatar,
  profileError,
}: ProfileSettingsProps) {
  const [copied, setCopied] = useState(false);
  // Custom photo upload is intentionally disabled for now — the profile always uses a generated
  // avatar (no user-supplied image ever enters the app). Clicking the button reveals a notice
  // instead of opening a file picker.
  const [photoSoon, setPhotoSoon] = useState(false);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(profile.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4">
        <Avatar
          src={avatar}
          name={displayName ?? profile.id}
          size="xl"
          className="ring-2 ring-purple-500/40"
        />
        <button type="button" className={SUBTLE_BUTTON} onClick={() => setPhotoSoon(true)}>
          <Image className="h-4 w-4" />
          Upload photo
        </button>
      </div>

      {photoSoon && (
        <StateBlock icon={Sparkles} title="Coming soon" compact role="status" ariaLive="polite">
          Photo upload isn&apos;t available yet — your profile uses a generated avatar.
        </StateBlock>
      )}

      <div>
        <span className="mb-2 block text-sm font-medium text-white/70">Display name</span>
        <p className="rounded-xl border border-white/5 bg-[#1a1a26] px-4 py-2.5 text-sm text-white">
          {displayName ?? '—'}
        </p>
      </div>

      <div>
        <span className="mb-2 block text-sm font-medium text-white/70">Argus ID</span>
        <div className="flex gap-2">
          <input
            value={profile.id}
            readOnly
            aria-label="Argus ID"
            className={`${INPUT} font-mono text-xs`}
          />
          <Button variant="subtle" onClick={() => void copyId()}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>

      <p className="text-xs text-white/60">Changes save automatically on this device.</p>
      {profileError && (
        <ErrorState
          error={createSafeUiError({ title: 'Profile not saved', message: profileError })}
          compact
        />
      )}
    </div>
  );
}
