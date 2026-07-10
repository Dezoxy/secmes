import { ReconnectBanner } from '@argus/web';

// ReconnectBanner (via StateBlock) uses translucent fill/white text, designed to sit on the app's
// dark shell (App.tsx's `bg-[#12121a]` panel) — never a bare page.
const shell = { background: '#12121a', padding: 16, borderRadius: 12 };

// `status="connected"` renders nothing by design (the banner only shows when live messages aren't
// flowing) — so the meaningful states to show are connecting/reconnecting/offline.
export function States() {
  return (
    <div style={{ ...shell, display: 'flex', flexDirection: 'column', gap: 10, width: 340 }}>
      <ReconnectBanner status="connecting" />
      <ReconnectBanner status="reconnecting" />
      <ReconnectBanner status="offline" />
    </div>
  );
}
