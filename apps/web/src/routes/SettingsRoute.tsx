import { Settings } from 'lucide-react';
import { ProfileEdit } from '../features/settings/ProfileEdit';
import { RoutePageShell } from './RoutePageShell';

export default function SettingsRoute() {
  return (
    <RoutePageShell
      eyebrow="Settings"
      title="Account settings"
      description="Manage your profile and account preferences."
      icon={Settings}
    >
      <div className="mx-auto max-w-lg space-y-4">
        <ProfileEdit />
      </div>
    </RoutePageShell>
  );
}
