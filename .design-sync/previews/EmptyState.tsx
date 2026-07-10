import { EmptyState } from '@argus/web';
import { Users } from 'lucide-react';

// EmptyState (via StateBlock) uses translucent-white fill/text, designed to sit on the app's dark
// shell (App.tsx's `bg-[#12121a]` panel) — never a bare page.
const shell = { background: '#12121a', padding: 16, borderRadius: 12 };

// Ported from real usage (features/chat/ConversationList.tsx, features/friends/FriendsScreen.tsx).
export function Default() {
  return (
    <div style={{ ...shell, width: 340 }}>
      <EmptyState title="No conversations yet" icon={Users} compact>
        Start a secure conversation when another member is available.
      </EmptyState>
    </div>
  );
}

export function WithoutIcon() {
  return (
    <div style={{ ...shell, width: 340 }}>
      <EmptyState title="Find a contact" compact>
        Paste the person's argus-id and press Look up.
      </EmptyState>
    </div>
  );
}
