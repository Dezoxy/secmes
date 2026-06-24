import { useEffect, useRef, useState } from 'react';
import { DISPLAY_NAME_MAX } from '@argus/contracts';
import { DisplayNameTakenError, updateProfile } from '../../lib/api';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../ui';
import { DISPLAY_NAME_HINT, displayNameFieldError } from './display-name';

/**
 * The validated, self-saving display-name editor. Shared by the Settings modal (ProfileSettings) and the
 * /settings route (ProfileEdit) so both edit the server display name through the same path
 * (updateProfile -> PUT /me -> refreshProfile). Renders nothing for unbound / breakglass profiles (the
 * server no-ops those anyway). Feedback is transient (toast) — no permanent helper text under the field.
 */
export function DisplayNameEditor() {
  const { profile, refreshProfile } = useAuth();
  const { toast } = useToast();

  const [displayName, setDisplayName] = useState(profile?.displayName ?? '');
  const [busy, setBusy] = useState(false);
  // Persistent invalid cue: the error toast self-dismisses, so mark the field so a screen reader that
  // returns to it still knows the value is invalid (WCAG ARIA21). Cleared on the next edit.
  const [hasError, setHasError] = useState(false);
  const initRef = useRef(false);

  // Populate once when the profile first becomes available after session restore.
  useEffect(() => {
    if (profile && !initRef.current) {
      initRef.current = true;
      setDisplayName(profile.displayName ?? '');
    }
  }, [profile]);

  if (!profile || profile.isBreakglass) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    // Validate on submit and surface the character/length policy as a toast (not as permanent helper text).
    if (displayNameFieldError(displayName) !== null) {
      toast(DISPLAY_NAME_HINT, { variant: 'error' });
      setHasError(true);
      return;
    }
    setBusy(true);
    try {
      // The value parses (checked above); trim/collapse is applied server-side too.
      await updateProfile({ displayName: displayName.trim().replace(/ +/g, ' ') });
      await refreshProfile();
      toast('Saved', { variant: 'success' });
    } catch (err) {
      if (err instanceof DisplayNameTakenError) {
        toast('This display name is already taken', { variant: 'error' });
        setHasError(true);
      } else {
        toast("Couldn't save — try again", { variant: 'error' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <label htmlFor="display-name" className="block text-xs text-white/50">
            Display name
          </label>
          <span className="text-[11px] tabular-nums text-white/30">
            {displayName.length}/{DISPLAY_NAME_MAX}
          </span>
        </div>
        <input
          id="display-name"
          type="text"
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
            setHasError(false);
          }}
          maxLength={DISPLAY_NAME_MAX}
          placeholder="Your name…"
          disabled={busy}
          aria-invalid={hasError || undefined}
          className="w-full rounded-xl border border-white/5 bg-[#1a1a26] px-4 py-2.5 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-purple-500/50 disabled:opacity-50 aria-[invalid=true]:border-red-400/60"
        />
      </div>

      <button
        type="submit"
        disabled={busy}
        className="self-end rounded-xl bg-purple-500 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-400 disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}
