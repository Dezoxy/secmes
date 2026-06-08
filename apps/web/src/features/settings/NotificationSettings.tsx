import { Bell } from 'lucide-react';
import { SettingsRow, StateBlock } from '../ui';

export function NotificationSettings() {
  return (
    <div className="space-y-3">
      <SettingsRow
        title="Push notifications"
        value="Automatically follows device permission"
        badge="Auto"
      />
      <SettingsRow title="Mentions only" value="Uses the product default" badge="Default" />
      <SettingsRow title="Quiet hours" value="Uses the product default" badge="Default" />
      <StateBlock icon={Bell} title="Conversation mute controls">
        Menu item is in place. We can wire the backend setting in the next pass.
      </StateBlock>
    </div>
  );
}
