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
        The editable settings modal now uses split section components. The route shell can reuse
        them once profile and device state move out of the chat surface.
      </StateBlock>
    </RoutePageShell>
  );
}
