import { useEffect, useState, type CSSProperties } from 'react';
import {
  Bell,
  Brush,
  ChevronLeft,
  ChevronRight,
  Database,
  HardDrive,
  Info,
  Lock,
  Shield,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  IconButton,
  Modal,
  modalBackdropEnterMotion,
  modalPanelEnterMotion,
  defaultAccentId,
  surfaceEnterMotion,
  getAccentById,
  isAccentId,
  type AccentId,
} from '../ui';
import { safeAvatarSrc } from '../chat/seed';
import {
  browserLocalStorage,
  LEGACY_ACCENT_STORAGE_KEY,
  LEGACY_FONT_SIZE_STORAGE_KEY,
  readVersionedRecord,
  versionedStorageKey,
  writeVersionedRecord,
} from '../../lib/persistence';
import { AboutSettings } from './AboutSettings';
import { AppearanceSettings, FONT_SIZE_LEVELS } from './AppearanceSettings';
import { DataStorageSettings } from './DataStorageSettings';
import { DeviceSettings } from './DeviceSettings';
import { NotificationSettings } from './NotificationSettings';
import { PrivacySettings } from './PrivacySettings';
import { ProfileSettings, type AnonymousProfile } from './ProfileSettings';
import { SecuritySettings } from './SecuritySettings';

export type { AnonymousProfile } from './ProfileSettings';

interface SettingsPanelProps {
  profile: AnonymousProfile;
  deviceId: string | null;
  onProfileChange: (profile: AnonymousProfile) => boolean;
  onClose: () => void;
}

type SectionId =
  | 'profile'
  | 'security'
  | 'privacy'
  | 'notifications'
  | 'appearance'
  | 'storage'
  | 'devices'
  | 'about';

const sections: Array<{ id: SectionId; label: string; icon: LucideIcon }> = [
  { id: 'profile', label: 'Profile', icon: UserRound },
  { id: 'security', label: 'Security & Recovery', icon: Shield },
  { id: 'privacy', label: 'Privacy', icon: Lock },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'appearance', label: 'Appearance', icon: Brush },
  { id: 'storage', label: 'Data & Storage', icon: Database },
  { id: 'devices', label: 'Devices', icon: HardDrive },
  { id: 'about', label: 'About', icon: Info },
];

const DEVICE_SETTINGS_STORAGE_KEY = versionedStorageKey('settings', 'device');

interface DeviceSettingsRecord {
  accentId: AccentId;
  fontSizeLevel: number;
}

function decodeDeviceSettingsRecord(value: unknown): DeviceSettingsRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const accentId = typeof record.accentId === 'string' ? record.accentId : defaultAccentId;
  const fontSizeLevel = typeof record.fontSizeLevel === 'number' ? record.fontSizeLevel : 5;

  return {
    accentId: isAccentId(accentId) ? accentId : defaultAccentId,
    fontSizeLevel: FONT_SIZE_LEVELS.includes(fontSizeLevel) ? fontSizeLevel : 5,
  };
}

function readStoredDeviceSettings(): DeviceSettingsRecord {
  if (typeof window === 'undefined') {
    return { accentId: defaultAccentId, fontSizeLevel: 5 };
  }

  const storage = browserLocalStorage();
  const stored = readVersionedRecord({
    storage,
    key: DEVICE_SETTINGS_STORAGE_KEY,
    decode: decodeDeviceSettingsRecord,
  });
  if (stored.status === 'ok') return stored.value;

  const legacyAccent = storage.getItem(LEGACY_ACCENT_STORAGE_KEY);
  const legacyFontSize = Number.parseInt(storage.getItem(LEGACY_FONT_SIZE_STORAGE_KEY) ?? '', 10);
  const migrated = {
    accentId: isAccentId(legacyAccent) ? legacyAccent : defaultAccentId,
    fontSizeLevel: FONT_SIZE_LEVELS.includes(legacyFontSize) ? legacyFontSize : 5,
  };

  writeVersionedRecord({ storage, key: DEVICE_SETTINGS_STORAGE_KEY, value: migrated });
  return migrated;
}

function writeStoredDeviceSettings(settings: DeviceSettingsRecord): void {
  if (typeof window === 'undefined') return;
  writeVersionedRecord({
    storage: browserLocalStorage(),
    key: DEVICE_SETTINGS_STORAGE_KEY,
    value: settings,
  });
}

function readStoredAccent(): AccentId {
  return readStoredDeviceSettings().accentId;
}

function readStoredFontSize(): number {
  return readStoredDeviceSettings().fontSizeLevel;
}

export function SettingsPanel({ profile, deviceId, onProfileChange, onClose }: SettingsPanelProps) {
  const [active, setActive] = useState<SectionId>('profile');
  const [mobileSectionOpen, setMobileSectionOpen] = useState(false);
  const [accentId, setAccentId] = useState<AccentId>(() => readStoredAccent());
  const [fontSizeLevel, setFontSizeLevel] = useState(() => readStoredFontSize());
  const [username, setUsername] = useState(profile.username);
  const [avatar, setAvatar] = useState(profile.avatar);
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    setUsername(profile.username);
    setAvatar(profile.avatar);
    setProfileError(null);
  }, [profile.avatar, profile.id, profile.username]);

  useEffect(() => {
    writeStoredDeviceSettings({ accentId, fontSizeLevel });
  }, [accentId, fontSizeLevel]);

  const activeSection = sections.find((section) => section.id === active) ?? sections[0]!;
  const ActiveIcon = activeSection.icon;
  const accent = getAccentById(accentId);
  const accentVariables = {
    '--settings-accent': accent.hex,
    '--settings-accent-soft': accent.soft,
  } as CSSProperties;

  useEffect(() => {
    const clean = username.trim();
    const safeAvatar = safeAvatarSrc(avatar, clean || profile.id);
    if (profile.username === clean && profile.avatar === safeAvatar) {
      setProfileError(null);
      return;
    }

    const handle = window.setTimeout(() => {
      if (onProfileChange({ id: profile.id, username: clean, avatar: safeAvatar })) {
        setProfileError(null);
        if (safeAvatar !== avatar) setAvatar(safeAvatar);
        return;
      }
      setProfileError('Profile could not be saved on this device. Use a smaller avatar.');
    }, 300);

    return () => window.clearTimeout(handle);
  }, [avatar, onProfileChange, profile.avatar, profile.id, profile.username, username]);

  return (
    <Modal
      ariaLabel="Settings"
      onClose={onClose}
      className={`items-center justify-center bg-black/80 p-4 backdrop-blur-sm ${modalBackdropEnterMotion}`}
      contentClassName={`flex h-[90vh] w-full max-w-4xl overflow-hidden rounded-2xl border border-white/5 bg-[#12121a] shadow-2xl shadow-black/50 sm:h-[82vh] ${modalPanelEnterMotion}`}
      style={accentVariables}
    >
      <aside
        className={`${
          mobileSectionOpen ? 'hidden' : 'flex'
        } w-full flex-col bg-[#0f0f16] p-4 sm:flex sm:w-64 sm:shrink-0 sm:border-r sm:border-white/5`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Settings</h2>
          <IconButton onClick={onClose} size="sm" aria-label="Close settings">
            <X className="h-5 w-5" />
          </IconButton>
        </div>
        <div className="space-y-1">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setActive(id);
                setMobileSectionOpen(true);
              }}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${
                active === id
                  ? 'text-white'
                  : 'text-white/55 hover:bg-white/[0.04] hover:text-white'
              }`}
              style={active === id ? { backgroundColor: accent.soft } : undefined}
            >
              <Icon className="h-4 w-4" />
              <span>{label}</span>
              <ChevronRight className="ml-auto h-4 w-4 text-white/25 sm:hidden" />
            </button>
          ))}
        </div>
      </aside>

      <main
        className={`${
          mobileSectionOpen ? 'block' : 'hidden'
        } flex-1 overflow-y-auto p-4 sm:block sm:p-6`}
      >
        <div key={active} className={surfaceEnterMotion}>
          <div className="mb-6 flex items-center gap-3">
            <IconButton
              onClick={() => setMobileSectionOpen(false)}
              className="sm:hidden"
              aria-label="Back to settings menu"
            >
              <ChevronLeft className="h-5 w-5" />
            </IconButton>
            <div
              className="flex h-10 w-10 items-center justify-center rounded-xl"
              style={{ backgroundColor: accent.soft }}
            >
              <ActiveIcon className="h-5 w-5" style={{ color: accent.hex }} />
            </div>
            <div className="min-w-0">
              <h3 className="text-xl font-semibold text-white">{activeSection.label}</h3>
              <p className="text-sm text-white/40">Anonymous account settings</p>
            </div>
            <IconButton onClick={onClose} className="ml-auto sm:hidden" aria-label="Close settings">
              <X className="h-5 w-5" />
            </IconButton>
          </div>

          {active === 'profile' && (
            <ProfileSettings
              profile={profile}
              username={username}
              avatar={avatar}
              profileError={profileError}
              onUsernameChange={setUsername}
              onAvatarChange={setAvatar}
              onProfileErrorChange={setProfileError}
            />
          )}

          {active === 'security' && <SecuritySettings />}

          {active === 'privacy' && <PrivacySettings />}

          {active === 'notifications' && <NotificationSettings />}

          {active === 'appearance' && (
            <AppearanceSettings
              accentId={accentId}
              fontSizeLevel={fontSizeLevel}
              onAccentIdChange={setAccentId}
              onFontSizeLevelChange={setFontSizeLevel}
            />
          )}

          {active === 'storage' && <DataStorageSettings />}

          {active === 'devices' && <DeviceSettings deviceId={deviceId} />}

          {active === 'about' && <AboutSettings />}
        </div>
      </main>
    </Modal>
  );
}
