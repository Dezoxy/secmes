import { useEffect, useMemo, useRef, useState } from 'react';
import { HardDrive } from 'lucide-react';
import type { Conversation as MlsGroup } from '@argus/crypto';
import { listEnrollments } from '../lib/api';
import type { MessagingDeps } from '../lib/messaging';
import { useAuth } from '../features/auth/AuthContext';
import { ApproveDevicePanel } from '../features/device/ApproveDevicePanel';
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

function DeviceApprovalPrompt() {
  const { profile } = useAuth();
  const { device, deviceId, deviceIsProvisional, keystore, sessionKey } = useDevice();
  const [pendingEnrollmentId, setPendingEnrollmentId] = useState<string | null>(null);
  const liveGroupsRef = useRef(new Map<string, MlsGroup>());

  const messagingDeps = useMemo<MessagingDeps | null>(
    () => (device && keystore && sessionKey ? { device, keystore, sessionKey } : null),
    [device, keystore, sessionKey],
  );

  useEffect(() => {
    if (!deviceId || deviceIsProvisional !== false) {
      setPendingEnrollmentId(null);
      return;
    }

    let active = true;
    const refreshPending = async () => {
      try {
        const rows = await listEnrollments('pending');
        if (!active) return;
        const pending = rows.find((row) => row.requestingDeviceId !== deviceId);
        setPendingEnrollmentId(pending?.id ?? null);
      } catch {
        if (active) setPendingEnrollmentId(null);
      }
    };

    void refreshPending();
    const timer = window.setInterval(() => void refreshPending(), 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [deviceId, deviceIsProvisional]);

  if (!pendingEnrollmentId || !profile?.userId) return null;

  return (
    <ApproveDevicePanel
      enrollmentId={pendingEnrollmentId}
      selfUserId={profile.userId}
      messagingDeps={messagingDeps}
      liveGroupsRef={liveGroupsRef}
      onClose={() => setPendingEnrollmentId(null)}
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
            <DeviceApprovalPrompt />
          </UnlockGate>
        </DeviceProvider>
        <EmptyState icon={HardDrive} title="Trusted-device list coming next">
          Listing and revoke controls stay placeholder-only until the backend contract is ready.
        </EmptyState>
      </div>
    </RoutePageShell>
  );
}
