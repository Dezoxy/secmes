import { V2Badge } from '@argus/web';
import { Check } from 'lucide-react';

// V2Badge's neutral tone renders as translucent white on the v2 sketchbook's own dark page
// background (v2ClassNames.page: bg-[#0b0d10]) — never a bare page.
const shell = { background: '#0b0d10', padding: 16, borderRadius: 12 };

// Ported from real usage — the v2 shell header always pairs a "Verified" badge (with icon) next to
// a plain protocol tag (v2/shell/V2Shell.tsx's V2SketchShell header).
export function Tones() {
  return (
    <div style={{ ...shell, display: 'flex', gap: 8 }}>
      <V2Badge tone="verified">
        <Check className="h-3.5 w-3.5" />
        Verified
      </V2Badge>
      <V2Badge>MLS</V2Badge>
      <V2Badge tone="warning">Needs review</V2Badge>
    </div>
  );
}
