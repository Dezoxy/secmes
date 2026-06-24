import { useChatContext } from '../features/chat/ChatContext';
import { ProfileSettings } from '../features/settings/ProfileSettings';
import { ArgusAppIcon } from '../features/brand/ArgusAppIcon';

export default function ProfileRoute() {
  const { anonymousProfile, serverProfile } = useChatContext();

  return (
    <div className="relative h-full sm:flex sm:items-center sm:justify-center sm:bg-[#1a1a24] sm:p-4">
      <div className="flex h-full flex-col overflow-hidden bg-[#0f0f16] sm:h-[calc(100%-2rem)] sm:w-full sm:max-w-2xl sm:rounded-3xl sm:bg-[#12121a] sm:shadow-2xl sm:shadow-black/50">
        <div className="bg-[#0f0f16] p-4 pt-[calc(env(safe-area-inset-top)_+_1rem)] sm:bg-[#12121a]">
          <h1 className="flex items-center justify-center gap-2">
            <ArgusAppIcon className="h-8 w-8 rounded-lg shadow-sm shadow-purple-500/25" />
            <span className="text-xl font-bold tracking-wider">
              <span className="bg-gradient-to-r from-[var(--argus-brand-400)] to-[var(--argus-brand-600)] bg-clip-text text-transparent">
                PROFILE
              </span>
            </span>
          </h1>
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
    </div>
  );
}
