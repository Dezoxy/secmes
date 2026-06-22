import { useEffect, useRef, useState } from 'react';
import { DISPLAY_NAME_MAX } from '@argus/contracts';
import { updateProfile } from '../../lib/api';
import { useAuth } from '../auth/AuthContext';
import { DISPLAY_NAME_HINT, displayNameFieldError } from './display-name';

/**
 * The validated, self-saving display-name editor. Shared by the Settings modal (ProfileSettings) and the
 * /settings route (ProfileEdit) so both edit the server display name through the same path
 * (updateProfile -> PUT /me -> refreshProfile). Renders nothing for unbound / breakglass profiles (the
 * server no-ops those anyway).
 */
export function DisplayNameEditor() {
  const { profile, refreshProfile } = useAuth();

  const [displayName, setDisplayName] = useState(profile?.displayName ?? '');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const initRef = useRef(false);

  // Populate once when the profile first becomes available after session restore.
  useEffect(() => {
    if (profile && !initRef.current) {
      initRef.current = true;
      setDisplayName(profile.displayName ?? '');
    }
  }, [profile]);

  if (!profile || profile.isBreakglass) return null;

  // Live validation derived from the shared policy; the rule message only shows once the user interacts.
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

  const describedBy = showValidationError
    ? 'display-name-error display-name-help'
    : 'display-name-help';

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
  );
}
