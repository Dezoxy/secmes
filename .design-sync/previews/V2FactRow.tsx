import { V2FactRow } from '@argus/web';

// V2FactRow's label/value use white/near-white text on the v2 sketchbook's own dark page
// background (v2ClassNames.page: bg-[#0b0d10]) — never a bare page.
const shell = { background: '#0b0d10', padding: 16, borderRadius: 12 };

export function Tones() {
  return (
    <div style={{ ...shell, display: 'flex', flexDirection: 'column', gap: 8, width: 320 }}>
      <V2FactRow label="Current browser" value="Trusted and unlocked." tone="verified" />
      <V2FactRow label="New device" value="Requires code confirmation." tone="warning" />
      <V2FactRow label="Pattern" value="Rows expose intent first, then a narrow detail pane." />
    </div>
  );
}
