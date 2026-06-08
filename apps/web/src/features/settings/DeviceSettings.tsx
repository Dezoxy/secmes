import { SettingsRow } from '../ui';

interface DeviceSettingsProps {
  deviceId: string | null;
}

export function DeviceSettings({ deviceId }: DeviceSettingsProps) {
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-white/5 bg-white/[0.03] p-4">
        <p className="text-sm font-medium text-white">Current device</p>
        <p className="mt-2 break-all font-mono text-xs text-white/45">
          {deviceId ?? 'Not provisioned yet'}
        </p>
      </div>
      <SettingsRow title="Trusted devices" value="Requires backend device registry UI" />
      <SettingsRow title="Revoke device" value="Requires backend revoke endpoint" />
    </div>
  );
}
