import { useState } from 'react';
import { LinkDevicePanel } from '../device/LinkDevicePanel';
import { Button, SettingsRow } from '../ui';

interface DeviceSettingsProps {
  deviceId: string | null;
}

export function DeviceSettings({ deviceId }: DeviceSettingsProps) {
  const [linkOpen, setLinkOpen] = useState(false);

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-white/5 bg-white/[0.03] p-4">
        <p className="text-sm font-medium text-white">Current device</p>
        <p className="mt-2 break-all font-mono text-xs text-white/60">
          {deviceId ?? 'Not provisioned yet'}
        </p>
      </div>
      {deviceId && (
        <Button variant="subtle" size="md" onClick={() => setLinkOpen(true)} className="w-full">
          Link another device
        </Button>
      )}
      <SettingsRow title="Trusted devices" value="Requires backend device registry UI" />
      <SettingsRow title="Revoke device" value="Requires backend revoke endpoint" />
      {linkOpen && <LinkDevicePanel onClose={() => setLinkOpen(false)} />}
    </div>
  );
}
