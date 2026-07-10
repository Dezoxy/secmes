import { SettingsRow } from '@argus/web';

// SettingsRow uses a near-transparent white fill/border and white text, designed to sit on the
// app's dark shell (App.tsx's `bg-[#12121a]` panel) — never a bare page.
const shell = { background: '#12121a', padding: 16, borderRadius: 12 };

// Ported from real usage (features/settings/NotificationSettings.tsx, PrivacySettings.tsx).
export function Toggle() {
  return (
    <div style={{ ...shell, display: 'flex', flexDirection: 'column', gap: 8, width: 360 }}>
      <SettingsRow title="Read receipts" value="On" enabled onClick={() => {}} />
      <SettingsRow title="Typing indicators" value="Off" enabled={false} onClick={() => {}} />
    </div>
  );
}

export function Badge() {
  return (
    <div style={{ ...shell, width: 360 }}>
      <SettingsRow
        title="Push notifications"
        value="Content-free pings only — zero message text reaches the server"
        badge="E2EE"
      />
    </div>
  );
}

export function StaticAndDisabled() {
  return (
    <div style={{ ...shell, display: 'flex', flexDirection: 'column', gap: 8, width: 360 }}>
      <SettingsRow title="App version" value="0.8.14" />
      <SettingsRow title="Notifications" value="Enabling…" enabled disabled onClick={() => {}} />
    </div>
  );
}
