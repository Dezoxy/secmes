import { SettingsRow } from '../ui';

export function DataStorageSettings() {
  return (
    <div className="space-y-3">
      <SettingsRow title="Encrypted local message cache" value="Stored on this device" enabled />
      <SettingsRow title="Clear local cache" value="Needs confirmation flow" />
      <SettingsRow title="Media auto-download" value="Off until attachment backend lands" />
    </div>
  );
}
