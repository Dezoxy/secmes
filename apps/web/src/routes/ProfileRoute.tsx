import { useChatContext } from '../features/chat/ChatContext';
import { ProfileSettings } from '../features/settings/ProfileSettings';
import { ArgusAppIcon } from '../features/brand/ArgusAppIcon';

export default function ProfileRoute() {
  const { anonymousProfile, serverProfile } = useChatContext();

  return (
    <div className="flex h-full flex-col bg-[#0f0f16]">
      <div className="border-b border-white/5 bg-[#0f0f16]/75 p-4 pt-[calc(env(safe-area-inset-top)_+_1rem)] backdrop-blur-xl">
        <div className="flex items-center gap-2">
          <ArgusAppIcon className="h-8 w-8 rounded-lg shadow-sm shadow-purple-500/25" />
          <span className="text-xl font-bold tracking-wider">
            <span className="bg-gradient-to-r from-purple-400 to-purple-600 bg-clip-text text-transparent">
              PROFILE
            </span>
          </span>
        </div>
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
