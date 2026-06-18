import { SettingsRow } from '../ui';

export function SecuritySettings() {
  return (
    <div className="space-y-3">
      <SettingsRow title="Login" value="Passkey only" badge="Secure" />
    </div>
  );
}
