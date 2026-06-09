import { Settings } from 'lucide-react';
import { EmptyState } from '../features/ui';
import { RoutePageShell } from './RoutePageShell';

export default function SettingsRoute() {
  return (
    <RoutePageShell
      eyebrow="Settings"
      title="Account settings"
      description="A route-owned settings surface for profile, security, privacy, notifications, appearance, storage, and devices."
      icon={Settings}
    >
      <EmptyState icon={Settings} title="Settings sections">
        The editable settings modal now uses split section components. The route shell can reuse
        them once profile and device state move out of the chat surface.
      </EmptyState>
    </RoutePageShell>
  );
}
