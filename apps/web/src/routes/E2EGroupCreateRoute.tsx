import { useState } from 'react';
import { GroupCreateDialog } from '../features/chat/GroupCreateDialog';
import type { GroupConversationManager } from '../lib/conversations';
import type { MessagingDeps } from '../lib/messaging';
import type { Friend } from '../lib/api';

const friends: Friend[] = [
  {
    userId: 'e5e5e5e5-0000-4000-8000-000000000005',
    argusId: 'argus-eveeveeveeveev-eve',
    displayName: 'Eve',
    avatarSeed: null,
    since: new Date(0).toISOString(),
  },
];

const manager = {
  prepare: async () => {
    throw new Error('E2E quick-add test does not create groups');
  },
} as unknown as GroupConversationManager;

const deps = {} as MessagingDeps;

export default function E2EGroupCreateRoute() {
  const [open, setOpen] = useState(true);

  return (
    <main className="min-h-[100dvh] bg-[#12121a] text-white">
      {open && (
        <GroupCreateDialog
          mode="create"
          manager={manager}
          deps={deps}
          selfUserId="self-user"
          friends={friends}
          onClose={() => setOpen(false)}
        />
      )}
    </main>
  );
}
