import { Button, SettingsRow } from '../ui';

export function DataStorageSettings() {
  return (
    <div className="space-y-3">
      <SettingsRow title="Encrypted local message cache" value="Stored on this device" badge="On" />
      <SettingsRow
        title="Clear local cache"
        value="Needs confirmation before clearing this browser"
        trailing={
          <Button variant="danger" size="sm" disabled>
            Reset
          </Button>
        }
      />
      <SettingsRow title="Media auto-download" value="Enabled by default" badge="On" />
    </div>
  );
}
