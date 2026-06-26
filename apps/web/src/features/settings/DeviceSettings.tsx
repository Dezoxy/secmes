import { useState } from 'react';
import { LinkDevicePanel } from '../device/LinkDevicePanel';
import { Button, SettingsRow } from '../ui';

interface DeviceSettingsProps {
  deviceId: string | null;
  deviceIsProvisional: boolean | null;
  onDeviceTrusted?: () => void;
}

export function DeviceSettings({
  deviceId,
  deviceIsProvisional,
  onDeviceTrusted,
}: DeviceSettingsProps) {
  const [linkOpen, setLinkOpen] = useState(false);
  const trusted = deviceId !== null && deviceIsProvisional === false;

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-white/5 bg-white/[0.03] p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-white">Current device</p>
          {deviceId && (
            <span
              className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
                trusted ? 'bg-green-500/10 text-green-300' : 'bg-amber-500/10 text-amber-300'
              }`}
            >
              {trusted ? 'Trusted' : 'Needs approval'}
            </span>
          )}
        </div>
        <p className="mt-2 break-all font-mono text-xs text-white/60">
          {deviceId ?? 'Not provisioned yet'}
        </p>
        {deviceId && deviceIsProvisional && (
          <p className="mt-3 text-xs leading-relaxed text-amber-200/80">
            This installed app is a new device. Approve it from an already-trusted device before
            relying on incoming conversations or restored history here.
          </p>
        )}
      </div>
      {deviceId && (
        <Button variant="subtle" size="md" onClick={() => setLinkOpen(true)} className="w-full">
          {deviceIsProvisional ? 'Request approval for this device' : 'Link another device'}
        </Button>
      )}
      <SettingsRow title="Trusted devices" value="Requires backend device registry UI" />
      <SettingsRow title="Revoke device" value="Requires backend revoke endpoint" />
      {linkOpen && (
        <LinkDevicePanel onClose={() => setLinkOpen(false)} onLinked={onDeviceTrusted} />
      )}
    </div>
  );
}
