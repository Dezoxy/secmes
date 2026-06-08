import { SettingsRow } from '../ui';

export function PrivacySettings() {
  return (
    <div className="space-y-3">
      <SettingsRow title="Read receipts" value="Uses the product default" badge="Default" />
      <SettingsRow title="Typing indicators" value="Uses the product default" badge="Default" />
      <SettingsRow title="Link previews" value="Uses the product default" badge="Default" />
    </div>
  );
}
