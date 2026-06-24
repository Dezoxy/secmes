import { SettingsPanel } from '../features/settings/SettingsPanel';
import { useChatContext } from '../features/chat/ChatContext';

export default function SettingsRoute() {
  const { anonymousProfile, serverProfile, handleProfileChange, deviceId } = useChatContext();

  return (
    <div className="relative h-full lg:flex lg:items-center lg:justify-center lg:bg-[#1a1a24] lg:p-4">
      <div className="flex h-full overflow-hidden lg:h-[calc(100%-2rem)] lg:w-full lg:max-w-2xl lg:rounded-3xl lg:bg-[#12121a] lg:shadow-2xl lg:shadow-black/50">
        <SettingsPanel
          standalone
          profile={anonymousProfile}
          deviceId={deviceId}
          serverHandle={serverProfile?.displayName ?? null}
          serverProfile={serverProfile}
          onProfileChange={handleProfileChange}
        />
      </div>
    </div>
  );
}
