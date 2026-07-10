import { StateBlock } from '@argus/web';
import { Inbox, Info, ShieldCheck } from 'lucide-react';

// StateBlock's fill/border/text are translucent-white, designed to sit on the app's dark shell
// (never a bare page) — the wrapper below supplies that real ambient background, matching how
// the app actually composes it (App.tsx's `bg-[#12121a]` panel).
const shell = { background: '#12121a', padding: 16, borderRadius: 12 };

// StateBlock is the shared shell behind EmptyState/ErrorState/LoadingState/ReconnectBanner (see
// their own preview files) — this card shows it used directly, with a custom icon and variant.
export function Variants() {
  return (
    <div style={{ ...shell, display: 'flex', flexDirection: 'column', gap: 10, width: 340 }}>
      <StateBlock icon={Info} title="Info" variant="info">
        A general status message.
      </StateBlock>
      <StateBlock icon={ShieldCheck} title="Device linked" variant="info" compact>
        This device can now send and receive messages.
      </StateBlock>
      <StateBlock icon={Inbox} title="No conversations yet" variant="empty" compact>
        Start a secure conversation when another member is available.
      </StateBlock>
    </div>
  );
}
