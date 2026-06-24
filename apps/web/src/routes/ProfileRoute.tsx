import { useChatContext } from '../features/chat/ChatContext';
import { ProfileSettings } from '../features/settings/ProfileSettings';
import { ArgusAppIcon } from '../features/brand/ArgusAppIcon';

export default function ProfileRoute() {
  const { anonymousProfile, serverProfile } = useChatContext();

  return (
    <div className="relative h-full lg:flex lg:items-center lg:justify-center lg:bg-[#1a1a24] lg:p-4">
      <div className="flex h-full flex-col overflow-hidden bg-[#0f0f16] lg:h-[calc(100%-2rem)] lg:w-full lg:max-w-2xl lg:rounded-3xl lg:bg-[#12121a] lg:shadow-2xl lg:shadow-black/50">
        <div className="bg-[#0f0f16] p-4 lg:bg-[#12121a]">
          <h1 className="flex items-center justify-center gap-2">
            <ArgusAppIcon className="h-8 w-8 rounded-lg shadow-sm shadow-purple-500/25" />
            <span className="text-xl font-bold tracking-wider">
              <span className="bg-gradient-to-r from-[var(--argus-brand-400)] to-[var(--argus-brand-600)] bg-clip-text text-transparent">
                PROFILE
              </span>
            </span>
          </h1>
        </div>
        <div className="flex-1 overflow-y-auto p-4 pb-[calc(env(safe-area-inset-bottom)_+_6rem)] lg:pb-[calc(env(safe-area-inset-bottom)_+_1rem)]">
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
    </div>
  );
}
