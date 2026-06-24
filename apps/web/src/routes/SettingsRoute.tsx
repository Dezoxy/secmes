import { SettingsPanel } from '../features/settings/SettingsPanel';
import { useChatContext } from '../features/chat/ChatContext';

export default function SettingsRoute() {
  const { anonymousProfile, serverProfile, handleProfileChange, deviceId } = useChatContext();

  return (
    <div className="relative h-full sm:flex sm:items-center sm:justify-center sm:bg-[#1a1a24] sm:p-4">
      <div className="flex h-full overflow-hidden sm:h-[calc(100%-2rem)] sm:w-full sm:max-w-2xl sm:rounded-3xl sm:bg-[#12121a] sm:shadow-2xl sm:shadow-black/50">
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
