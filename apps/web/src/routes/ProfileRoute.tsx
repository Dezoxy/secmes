import { useChatContext } from '../features/chat/ChatContext';
import { ProfileSettings } from '../features/settings/ProfileSettings';

export default function ProfileRoute() {
  const { anonymousProfile, serverProfile } = useChatContext();

  return (
    <div className="flex h-full flex-col bg-[#0f0f16]">
      <div className="border-b border-white/5 bg-[#0f0f16]/75 p-4 pt-[calc(env(safe-area-inset-top)_+_1rem)] backdrop-blur-xl">
        <h1 className="text-xl font-bold text-white">Profile</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-4 pb-[calc(env(safe-area-inset-bottom)_+_1rem)]">
        <div className="mx-auto max-w-lg">
          <ProfileSettings
            profile={anonymousProfile}
            displayName={serverProfile?.displayName ?? null}
            avatar={anonymousProfile.avatar}
            profileError={null}
          />
        </div>
      </div>
    </div>
  );
}
