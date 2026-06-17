import { Shield } from 'lucide-react';
import { StateBlock } from '../features/ui';
import { RoutePageShell } from './RoutePageShell';

export default function SecurityRoute() {
  return (
    <RoutePageShell
      eyebrow="Security"
      title="Security"
      description="Passkey-first account access and local device unlock state live here — no username or password login UI."
      icon={Shield}
    >
      <StateBlock icon={Shield} title="Unlocked by your passkey">
        Your encrypted messages are unlocked on each device by your passkey (WebAuthn PRF) — there
        is no passphrase and nothing to back up. If a passkey is lost, ask your admin for a new
        registration code to set up that device fresh; there is no recovery file.
      </StateBlock>
    </RoutePageShell>
  );
}
