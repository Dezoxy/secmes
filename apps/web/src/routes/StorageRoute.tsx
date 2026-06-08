import { Database } from 'lucide-react';
import { StateBlock } from '../features/ui';
import { RoutePageShell } from './RoutePageShell';

export default function StorageRoute() {
  return (
    <RoutePageShell
      eyebrow="Storage"
      title="Data & storage"
      description="A route-owned storage surface for encrypted local cache controls, media behavior, and future cleanup flows."
      icon={Database}
    >
      <StateBlock icon={Database} title="Encrypted local state only">
        Plaintext messages, private keys, auth tokens, presigned URLs, and decrypted attachments
        must stay out of browser storage. Cleanup controls will be wired after versioned persistence
        lands.
      </StateBlock>
    </RoutePageShell>
  );
}
