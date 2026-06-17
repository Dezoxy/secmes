import { SettingsRow } from '../ui';

export function SecuritySettings() {
  return (
    <div className="space-y-3">
      <SettingsRow title="Login" value="Passkey only" badge="Secure" />
      <SettingsRow title="Device unlock" value="Your passkey (no password)" />
      <p className="px-1 text-xs leading-relaxed text-white/45">
        Your messages are encrypted on this device with a key only your passkey can unlock — there
        is no password and nothing to back up. If you lose your passkey, ask your admin for a new
        registration code to set up this device fresh; past messages on a lost device can’t be
        recovered.
      </p>
    </div>
  );
}
