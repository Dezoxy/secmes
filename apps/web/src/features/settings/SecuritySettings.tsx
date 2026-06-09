import { Suspense, lazy } from 'react';
import { SettingsRow } from '../ui';

const RecoveryPanel = lazy(() =>
  import('../recovery/RecoveryPanel').then((module) => ({ default: module.RecoveryPanel })),
);

function RecoveryPanelFallback() {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.03] p-4 text-sm text-white/45">
      Loading recovery tools...
    </div>
  );
}

export function SecuritySettings() {
  return (
    <div className="space-y-3">
      <SettingsRow title="Passkey-only login" value="Managed by Zitadel policy" badge="Managed" />
      <Suspense fallback={<RecoveryPanelFallback />}>
        <RecoveryPanel embedded />
      </Suspense>
    </div>
  );
}
