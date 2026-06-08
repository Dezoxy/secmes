import { Settings } from 'lucide-react';
import { StateBlock } from '../features/ui';
import { RoutePageShell } from './RoutePageShell';

export default function SettingsRoute() {
  return (
    <RoutePageShell
      eyebrow="Settings"
      title="Account settings"
      description="A route-owned settings surface for profile, security, privacy, notifications, appearance, storage, and devices."
      icon={Settings}
    >
      <StateBlock icon={Settings} title="Settings sections">
        The chat modal still owns the editable settings panel in this step. Step 8 will move those
        sections behind explicit route-owned components without changing the passkey-first identity
        model.
      </StateBlock>
    </RoutePageShell>
  );
}
