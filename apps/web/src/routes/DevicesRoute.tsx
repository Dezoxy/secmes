import { HardDrive } from 'lucide-react';
import { EmptyState } from '../features/ui';
import { DeviceProvider, useDevice } from '../features/device/DeviceContext';
import { UnlockGate } from '../features/device/UnlockGate';
import { DeviceSettings } from '../features/settings/DeviceSettings';
import { RoutePageShell } from './RoutePageShell';

function CurrentDeviceSettings() {
  const { deviceId, deviceIsProvisional, markDeviceTrusted } = useDevice();
  return (
    <DeviceSettings
      deviceId={deviceId}
      deviceIsProvisional={deviceIsProvisional}
      onDeviceTrusted={markDeviceTrusted}
    />
  );
}

export default function DevicesRoute() {
  return (
    <RoutePageShell
      eyebrow="Devices"
      title="Trusted devices"
      description="A route-owned device surface for current-device status, trusted-device listing, and future revoke controls."
      icon={HardDrive}
    >
      <div className="space-y-4">
        <DeviceProvider>
          <UnlockGate>
            <CurrentDeviceSettings />
          </UnlockGate>
        </DeviceProvider>
        <EmptyState icon={HardDrive} title="Trusted-device list coming next">
          Listing and revoke controls stay placeholder-only until the backend contract is ready.
        </EmptyState>
      </div>
    </RoutePageShell>
  );
}
