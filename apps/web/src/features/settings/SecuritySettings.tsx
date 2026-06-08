import { RecoveryPanel } from '../recovery/RecoveryPanel';
import { SettingsRow } from '../ui';

export function SecuritySettings() {
  return (
    <div className="space-y-3">
      <SettingsRow title="Passkey-only login" value="Managed by Zitadel policy" badge="Managed" />
      <RecoveryPanel embedded />
    </div>
  );
}
