import { HardDrive } from 'lucide-react';
import { StateBlock } from '../features/ui';
import { RoutePageShell } from './RoutePageShell';

export default function DevicesRoute() {
  return (
    <RoutePageShell
      eyebrow="Devices"
      title="Trusted devices"
      description="A route-owned device surface for current-device status, trusted-device listing, and future revoke controls."
      icon={HardDrive}
    >
      <StateBlock icon={HardDrive} title="Device management shell">
        Device provisioning and unlock still run through the existing device provider. Listing and
        revoke controls stay placeholder-only until the backend contract is ready.
      </StateBlock>
    </RoutePageShell>
  );
}
