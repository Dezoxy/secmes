import { V2AsidePanel, V2FactRow } from '@argus/web';

// V2AsidePanel's title/text use white/near-white colors on the v2 sketchbook's own dark page
// background (v2ClassNames.page: bg-[#0b0d10]) — never a bare page.
const shell = { background: '#0b0d10', padding: 16, borderRadius: 12 };

// Ported from real usage — v2/routes/V2PageSketches.tsx composes V2AsidePanel as a sidebar of
// V2FactRow entries (settings, security, and devices sketches all follow this exact pattern).
export function SecurityStates() {
  return (
    <div style={{ ...shell, width: 280 }}>
      <V2AsidePanel title="Security states">
        <V2FactRow
          label="Passkey login"
          value="Discoverable passkey, no password."
          tone="verified"
        />
        <V2FactRow label="New device" value="Requires code confirmation." tone="warning" />
      </V2AsidePanel>
    </div>
  );
}
