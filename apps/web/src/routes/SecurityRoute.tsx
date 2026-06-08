import { Shield } from 'lucide-react';
import { StateBlock } from '../features/ui';
import { RoutePageShell } from './RoutePageShell';

export default function SecurityRoute() {
  return (
    <RoutePageShell
      eyebrow="Security"
      title="Security & recovery"
      description="Passkey-first account access, local device unlock state, and recovery controls live here without adding username or password login UI."
      icon={Shield}
    >
      <StateBlock icon={Shield} title="Recovery remains embedded">
        The recovery workflow stays under Security & Recovery. The app does not create a separate
        username/password recovery route because registration and passkey policy are handled by
        Zitadel.
      </StateBlock>
    </RoutePageShell>
  );
}
