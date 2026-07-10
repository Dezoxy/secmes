import { LoadingState } from '@argus/web';

// LoadingState (via StateBlock) uses translucent fill/white text, designed to sit on the app's
// dark shell (App.tsx's `bg-[#12121a]` panel) — never a bare page.
const shell = { background: '#12121a', padding: 16, borderRadius: 12 };

export function Default() {
  return (
    <div style={{ ...shell, width: 340 }}>
      <LoadingState />
    </div>
  );
}

export function CustomCopy() {
  return (
    <div style={{ ...shell, width: 340 }}>
      <LoadingState title="Verifying" compact>
        Checking your safety number…
      </LoadingState>
    </div>
  );
}
