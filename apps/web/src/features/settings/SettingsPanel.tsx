import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
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
import {
  DEFAULT_PRIVACY_SETTINGS,
  PrivacySettings,
  type PrivacySettingsRecord,
} from './PrivacySettings';
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
const PRIVACY_SETTINGS_STORAGE_KEY = versionedStorageKey('settings', 'privacy');

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

function decodePrivacySettingsRecord(value: unknown): PrivacySettingsRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  return {
    readReceipts:
      typeof record.readReceipts === 'boolean'
        ? record.readReceipts
        : DEFAULT_PRIVACY_SETTINGS.readReceipts,
    typingIndicators:
      typeof record.typingIndicators === 'boolean'
        ? record.typingIndicators
        : DEFAULT_PRIVACY_SETTINGS.typingIndicators,
    linkPreviews:
      typeof record.linkPreviews === 'boolean'
        ? record.linkPreviews
        : DEFAULT_PRIVACY_SETTINGS.linkPreviews,
  };
}

function readStoredPrivacySettings(): PrivacySettingsRecord {
  if (typeof window === 'undefined') return DEFAULT_PRIVACY_SETTINGS;

  const stored = readVersionedRecord({
    storage: browserLocalStorage(),
    key: PRIVACY_SETTINGS_STORAGE_KEY,
    decode: decodePrivacySettingsRecord,
  });

  return stored.status === 'ok' ? stored.value : DEFAULT_PRIVACY_SETTINGS;
}

function writeStoredPrivacySettings(settings: PrivacySettingsRecord): void {
  if (typeof window === 'undefined') return;
  writeVersionedRecord({
    storage: browserLocalStorage(),
    key: PRIVACY_SETTINGS_STORAGE_KEY,
    value: settings,
  });
}

function isMobileSettingsViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches;
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
  const [privacySettings, setPrivacySettings] = useState<PrivacySettingsRecord>(() =>
    readStoredPrivacySettings(),
  );
  const [username, setUsername] = useState(profile.username);
  const [avatar, setAvatar] = useState(profile.avatar);
  const [profileError, setProfileError] = useState<string | null>(null);
  const sectionButtonRefs = useRef(new Map<SectionId, HTMLButtonElement>());
  const sectionContentRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setUsername(profile.username);
    setAvatar(profile.avatar);
    setProfileError(null);
  }, [profile.avatar, profile.id, profile.username]);

  useEffect(() => {
    writeStoredDeviceSettings({ accentId, fontSizeLevel });
  }, [accentId, fontSizeLevel]);

  useEffect(() => {
    writeStoredPrivacySettings(privacySettings);
  }, [privacySettings]);

  const activeSection = sections.find((section) => section.id === active) ?? sections[0]!;
  const ActiveIcon = activeSection.icon;
  const accent = getAccentById(accentId);
  const accentVariables = {
    '--settings-accent': accent.hex,
    '--settings-accent-soft': accent.soft,
  } as CSSProperties;

  const saveProfileDraft = useCallback(
    (draftUsername: string, draftAvatar: string): boolean => {
      const clean = draftUsername.trim();
      const safeAvatar = safeAvatarSrc(draftAvatar, clean || profile.id);

      if (profile.username === clean && profile.avatar === safeAvatar) {
        setProfileError(null);
        return true;
      }

      if (onProfileChange({ id: profile.id, username: clean, avatar: safeAvatar })) {
        setProfileError(null);
        if (safeAvatar !== draftAvatar) setAvatar(safeAvatar);
        return true;
      }

      setProfileError('Profile could not be saved on this device. Use a smaller avatar.');
      return false;
    },
    [onProfileChange, profile.avatar, profile.id, profile.username],
  );

  const closeSettings = useCallback(() => {
    saveProfileDraft(username, avatar);
    onClose();
  }, [avatar, onClose, saveProfileDraft, username]);

  const openSection = useCallback((id: SectionId) => {
    setActive(id);
    if (isMobileSettingsViewport()) setMobileSectionOpen(true);
  }, []);

  const returnToSettingsMenu = useCallback(() => {
    setMobileSectionOpen(false);
    window.requestAnimationFrame(() => {
      sectionButtonRefs.current.get(active)?.focus({ preventScroll: true });
    });
  }, [active]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      saveProfileDraft(username, avatar);
    }, 300);

    return () => window.clearTimeout(handle);
  }, [avatar, saveProfileDraft, username]);

  useEffect(() => {
    if (!mobileSectionOpen || !isMobileSettingsViewport()) return undefined;

    const animationFrame = window.requestAnimationFrame(() => {
      sectionContentRef.current?.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [active, mobileSectionOpen]);

  return (
    <Modal
      ariaLabel="Settings"
      onClose={closeSettings}
      className={`items-center justify-center bg-black/80 p-2 backdrop-blur-sm sm:p-4 ${modalBackdropEnterMotion}`}
      contentClassName={`flex h-[calc(100dvh-1rem)] w-full max-w-4xl overflow-hidden rounded-xl border border-white/5 bg-[#12121a] shadow-2xl shadow-black/50 sm:h-[82vh] sm:rounded-2xl ${modalPanelEnterMotion}`}
      style={accentVariables}
    >
      <aside
        className={`${
          mobileSectionOpen ? 'hidden' : 'flex'
        } w-full flex-col bg-[#0f0f16] p-3 sm:flex sm:w-64 sm:shrink-0 sm:border-r sm:border-white/5 sm:p-4`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Settings</h2>
          <IconButton onClick={closeSettings} size="sm" aria-label="Close settings">
            <X className="h-5 w-5" />
          </IconButton>
        </div>
        <nav className="space-y-1" aria-label="Settings sections">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              ref={(node) => {
                if (node) sectionButtonRefs.current.set(id, node);
                else sectionButtonRefs.current.delete(id);
              }}
              type="button"
              onClick={() => openSection(id)}
              aria-current={active === id ? 'page' : undefined}
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
        </nav>
      </aside>

      <section
        ref={sectionContentRef}
        role="region"
        aria-label={`${activeSection.label} settings`}
        tabIndex={-1}
        className={`${
          mobileSectionOpen ? 'block' : 'hidden'
        } flex-1 overflow-y-auto p-3 focus:outline-none sm:block sm:p-6`}
      >
        <div key={active} className={surfaceEnterMotion}>
          <div className="mb-4 flex items-center gap-3 sm:mb-6">
            <IconButton
              onClick={returnToSettingsMenu}
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
            <IconButton
              onClick={closeSettings}
              className="ml-auto sm:hidden"
              aria-label="Close settings"
            >
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

          {active === 'privacy' && (
            <PrivacySettings settings={privacySettings} onSettingsChange={setPrivacySettings} />
          )}

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
      </section>
    </Modal>
  );
}
