import { useEffect, useState } from 'react';
import { HardDrive } from 'lucide-react';
import { listEnrollments } from '../lib/api';
import { useAuth } from '../features/auth/AuthContext';
import { useChatContext } from '../features/chat/ChatContext';
import { ApproveDevicePanel } from '../features/device/ApproveDevicePanel';
import { EmptyState } from '../features/ui';
import { useDevice } from '../features/device/DeviceContext';
import { DeviceSettings } from '../features/settings/DeviceSettings';
import { useSetNavVisible } from './NavVisibilityContext';
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
  const { deviceId, deviceIsProvisional } = useDevice();
  const { liveGroups, messagingDeps } = useChatContext();
  const [pendingEnrollmentId, setPendingEnrollmentId] = useState<string | null>(null);

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
      liveGroupsRef={liveGroups}
      onClose={() => setPendingEnrollmentId(null)}
    />
  );
}

export default function DevicesRoute() {
  const setNavVisible = useSetNavVisible();

  useEffect(() => {
    setNavVisible(false);
    return () => setNavVisible(true);
  }, [setNavVisible]);

  return (
    <RoutePageShell
      eyebrow="Devices"
      title="Trusted devices"
      description="A route-owned device surface for current-device status, trusted-device listing, and future revoke controls."
      icon={HardDrive}
    >
      <div className="space-y-4">
        <CurrentDeviceSettings />
        <DeviceApprovalPrompt />
        <EmptyState icon={HardDrive} title="Trusted-device list coming next">
          Listing and revoke controls stay placeholder-only until the backend contract is ready.
        </EmptyState>
      </div>
    </RoutePageShell>
  );
}
