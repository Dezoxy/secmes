import { SettingsPanel } from '../features/settings/SettingsPanel';
import { useChatContext } from '../features/chat/ChatContext';

export default function SettingsRoute() {
  const { anonymousProfile, serverProfile, handleProfileChange, deviceId } = useChatContext();

  return (
    <SettingsPanel
      standalone
      profile={anonymousProfile}
      deviceId={deviceId}
      serverHandle={serverProfile?.displayName ?? null}
      serverProfile={serverProfile}
      onProfileChange={handleProfileChange}
    />
  );
}
