import { useEffect, useRef, useState } from 'react';
import { User } from 'lucide-react';
import { DISPLAY_NAME_MAX } from '@argus/contracts';
import { updateProfile } from '../../lib/api';
import { useAuth } from '../auth/AuthContext';
import { DISPLAY_NAME_HINT, displayNameFieldError } from './display-name';

export function ProfileEdit() {
  const { profile, refreshProfile } = useAuth();

  const [displayName, setDisplayName] = useState(profile?.displayName ?? '');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const initRef = useRef(false);

  // Populate the field once when the profile first becomes available after session restore.
  useEffect(() => {
    if (profile && !initRef.current) {
      initRef.current = true;
      setDisplayName(profile.displayName ?? '');
    }
  }, [profile]);

  if (!profile || profile.isBreakglass) return null;

  // Live validation: derived each render from the shared policy — no separate error state to keep in
  // sync. The rule message only shows once the user has interacted (typed or blurred) so an untouched
  // field is not pre-flagged.
  const validationError = displayNameFieldError(displayName);
  const showValidationError = touched && validationError !== null;
  const canSave = !busy && validationError === null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) {
      setTouched(true);
      return;
    }
    setServerError(null);
    setSaved(false);
    setBusy(true);
    try {
      // validationError === null guarantees the value parses; trim/collapse is applied server-side too.
      await updateProfile({ displayName: displayName.trim().replace(/ +/g, ' ') });
      await refreshProfile();
      setSaved(true);
    } catch {
      setServerError('Save failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  // Point the field at the error (when shown) AND always at the rule hint, so the policy guidance is
  // still announced/visible while an error is up.
  const describedBy = showValidationError
    ? 'display-name-error display-name-help'
    : 'display-name-help';

  return (
    <section className="rounded-2xl border border-white/5 bg-[#12121a] p-5">
      <div className="mb-4 flex items-center gap-2">
        <User className="h-4 w-4 text-purple-400" />
        <h2 className="text-sm font-semibold text-white">Profile</h2>
      </div>

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
              setTouched(true);
              setSaved(false);
              setServerError(null);
            }}
            onBlur={() => setTouched(true)}
            maxLength={DISPLAY_NAME_MAX}
            placeholder="Your name…"
            disabled={busy}
            aria-invalid={showValidationError || undefined}
            aria-describedby={describedBy}
            className="w-full rounded-xl border border-white/5 bg-[#1a1a26] px-4 py-2.5 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-purple-500/50 disabled:opacity-50 aria-[invalid=true]:border-red-400/60"
          />
          {showValidationError && (
            <p
              id="display-name-error"
              role="alert"
              aria-live="polite"
              className="mt-1.5 text-xs text-red-400"
            >
              {validationError}
            </p>
          )}
          {/* Always visible — the rule guidance must not disappear while an error is shown. */}
          <p id="display-name-help" className="mt-1.5 text-xs text-white/40">
            {DISPLAY_NAME_HINT}
          </p>
        </div>

        <div>
          <p className="mb-1.5 text-xs text-white/50">Argus ID</p>
          <p className="select-all rounded-xl border border-white/5 bg-[#0f0f16] px-4 py-2.5 font-mono text-xs text-white/60">
            {profile.argusId}
          </p>
        </div>

        {serverError && <p className="text-xs text-red-400">{serverError}</p>}
        {saved && <p className="text-xs text-green-400">Saved.</p>}

        <button
          type="submit"
          disabled={!canSave}
          className="self-end rounded-xl bg-purple-500 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-400 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>
    </section>
  );
}
