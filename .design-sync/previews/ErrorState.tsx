import { ErrorState } from '@argus/web';

// ErrorState (via StateBlock) uses translucent fill/white text, designed to sit on the app's dark
// shell (App.tsx's `bg-[#12121a]` panel) — never a bare page.
const shell = { background: '#12121a', padding: 16, borderRadius: 12 };

// Ported from real usage (features/settings/ProfileSettings.tsx) — title/message flow through
// toSafeUiError untouched when `error` is omitted, which is the realistic "known, friendly error"
// case (as opposed to wrapping a caught network/API error).
export function Default() {
  return (
    <div style={{ ...shell, width: 340 }}>
      <ErrorState title="Profile not saved" message="That display name is already taken." />
    </div>
  );
}

export function Compact() {
  return (
    <div style={{ ...shell, width: 340 }}>
      <ErrorState title="Couldn't send" message="Check your connection and try again." compact />
    </div>
  );
}
