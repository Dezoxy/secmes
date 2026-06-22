import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  Bell,
  Brush,
  ChevronLeft,
  ChevronRight,
  Database,
  Info,
  Lock,
  ShieldCheck,
  Shield,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  IconButton,
  Modal,
  modalBackdropEnterMotion,
  modalBackdropExitMotion,
  modalPanelEnterMotion,
  modalPanelExitMotion,
  paneBackEnterMotion,
  paneBackExitMotion,
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
import { NotificationSettings } from './NotificationSettings';
import { PrivacySettings, type PrivacySettingsRecord } from './PrivacySettings';
import { readStoredPrivacySettings, writeStoredPrivacySettings } from './privacy-settings';
import { ProfileSettings, type AnonymousProfile } from './ProfileSettings';
import { SecuritySettings } from './SecuritySettings';
import { AdminPanel } from './AdminPanel';
import { TeamSettings } from './TeamSettings';
import type { MeBound } from '../../lib/api';

export type { AnonymousProfile } from './ProfileSettings';

interface SettingsPanelProps {
  profile: AnonymousProfile;
  deviceId: string | null;
  serverHandle: string | null;
  /** Full server profile — used to render admin-only sections. */
  serverProfile?: MeBound | null;
  onProfileChange: (profile: AnonymousProfile) => boolean;
  onClose: () => void;
}

type SectionId =
  | 'security'
  | 'privacy'
  | 'notifications'
  | 'appearance'
  | 'storage'
  | 'about'
  | 'team'
  | 'admin';

const baseSections: Array<{ id: SectionId; label: string; icon: LucideIcon }> = [
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'privacy', label: 'Privacy', icon: Lock },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'appearance', label: 'Appearance', icon: Brush },
  { id: 'storage', label: 'Data & Storage', icon: Database },
  { id: 'about', label: 'About', icon: Info },
];

const teamSection: { id: SectionId; label: string; icon: LucideIcon } = {
  id: 'team',
  label: 'Team',
  icon: Users,
};

const adminSection: { id: SectionId; label: string; icon: LucideIcon } = {
  id: 'admin',
  label: 'Admin',
  icon: ShieldCheck,
};

const DEVICE_SETTINGS_STORAGE_KEY = versionedStorageKey('settings', 'device');
const SETTINGS_CLOSE_ANIMATION_MS = 220;

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

function isMobileSettingsViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function readStoredAccent(): AccentId {
  return readStoredDeviceSettings().accentId;
}

function readStoredFontSize(): number {
  return readStoredDeviceSettings().fontSizeLevel;
}

export function SettingsPanel({
  profile,
  deviceId,
  serverHandle,
  serverProfile,
  onProfileChange,
  onClose,
}: SettingsPanelProps) {
  const isAdmin = serverProfile?.role === 'admin';
  const sections = isAdmin ? [...baseSections, teamSection, adminSection] : baseSections;
  const [active, setActive] = useState<SectionId>('security');
  const [closing, setClosing] = useState(false);
  const [mobileSectionOpen, setMobileSectionOpen] = useState(false);
  const [mobileBackAnimating, setMobileBackAnimating] = useState(false);
  const [mobileMenuReturning, setMobileMenuReturning] = useState(false);
  const [accentId, setAccentId] = useState<AccentId>(() => readStoredAccent());
  const [fontSizeLevel, setFontSizeLevel] = useState(() => readStoredFontSize());
  const [privacySettings, setPrivacySettings] = useState<PrivacySettingsRecord>(() =>
    readStoredPrivacySettings(),
  );
  const [avatar, setAvatar] = useState(profile.avatar);
  const [profileError, setProfileError] = useState<string | null>(null);
  const sectionButtonRefs = useRef(new Map<SectionId, HTMLButtonElement>());
  const sectionContentRef = useRef<HTMLElement>(null);
  const mobileBackTimerRef = useRef<number | undefined>(undefined);
  const mobileMenuTimerRef = useRef<number | undefined>(undefined);
  const closeTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    setAvatar(profile.avatar);
    setProfileError(null);
  }, [profile.avatar, profile.id]);

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
    (draftAvatar: string): boolean => {
      const safeAvatar = safeAvatarSrc(draftAvatar, profile.username || profile.id);

      if (profile.avatar === safeAvatar) {
        setProfileError(null);
        return true;
      }

      if (onProfileChange({ id: profile.id, username: profile.username, avatar: safeAvatar })) {
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
    if (closing) return;

    saveProfileDraft(avatar);

    if (prefersReducedMotion()) {
      onClose();
      return;
    }

    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      onClose();
    }, SETTINGS_CLOSE_ANIMATION_MS);
  }, [avatar, closing, onClose, saveProfileDraft]);

  const openSection = useCallback((id: SectionId) => {
    if (mobileBackTimerRef.current !== undefined) window.clearTimeout(mobileBackTimerRef.current);
    if (mobileMenuTimerRef.current !== undefined) window.clearTimeout(mobileMenuTimerRef.current);
    setMobileBackAnimating(false);
    setMobileMenuReturning(false);
    setActive(id);
    if (isMobileSettingsViewport()) setMobileSectionOpen(true);
  }, []);

  const returnToSettingsMenu = useCallback(() => {
    if (!isMobileSettingsViewport() || prefersReducedMotion()) {
      setMobileSectionOpen(false);
      window.requestAnimationFrame(() => {
        sectionButtonRefs.current.get(active)?.focus({ preventScroll: true });
      });
      return;
    }

    if (mobileBackTimerRef.current !== undefined) window.clearTimeout(mobileBackTimerRef.current);
    if (mobileMenuTimerRef.current !== undefined) window.clearTimeout(mobileMenuTimerRef.current);

    setMobileBackAnimating(true);
    mobileBackTimerRef.current = window.setTimeout(() => {
      setMobileSectionOpen(false);
      setMobileBackAnimating(false);
      setMobileMenuReturning(true);
      window.requestAnimationFrame(() => {
        sectionButtonRefs.current.get(active)?.focus({ preventScroll: true });
      });
      mobileMenuTimerRef.current = window.setTimeout(() => {
        setMobileMenuReturning(false);
      }, 220);
    }, 180);
  }, [active]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      saveProfileDraft(avatar);
    }, 300);

    return () => window.clearTimeout(handle);
  }, [avatar, saveProfileDraft]);

  useEffect(() => {
    if (!mobileSectionOpen || !isMobileSettingsViewport()) return undefined;

    const animationFrame = window.requestAnimationFrame(() => {
      sectionContentRef.current?.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [active, mobileSectionOpen]);

  useEffect(() => {
    return () => {
      if (mobileBackTimerRef.current !== undefined) window.clearTimeout(mobileBackTimerRef.current);
      if (mobileMenuTimerRef.current !== undefined) window.clearTimeout(mobileMenuTimerRef.current);
      if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  return (
    <Modal
      ariaLabel="Settings"
      onClose={closeSettings}
      className={`items-center justify-center bg-black/40 p-4 backdrop-blur-md ${
        closing ? modalBackdropExitMotion : modalBackdropEnterMotion
      }`}
      contentClassName={`flex h-[90vh] w-full max-w-6xl overflow-hidden rounded-3xl border border-white/5 bg-[#12121a] shadow-2xl shadow-black/50 ${
        closing ? modalPanelExitMotion : modalPanelEnterMotion
      }`}
      style={accentVariables}
    >
      <aside
        className={`${
          mobileSectionOpen || mobileBackAnimating ? 'hidden' : 'flex'
        } w-full flex-col overflow-y-auto bg-[#0f0f16] p-3 sm:flex sm:w-80 sm:shrink-0 sm:border-r sm:border-white/5 sm:p-4 ${
          mobileMenuReturning ? paneBackEnterMotion : ''
        }`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Settings</h2>
          <IconButton onClick={closeSettings} size="sm" aria-label="Close settings">
            <X className="h-5 w-5" />
          </IconButton>
        </div>

        <section
          className="rounded-2xl border border-white/5 bg-white/[0.02] p-3"
          aria-labelledby="settings-profile-heading"
        >
          <h3 id="settings-profile-heading" className="mb-4 text-base font-semibold text-white">
            Profile
          </h3>
          <ProfileSettings
            profile={profile}
            displayName={serverHandle}
            avatar={avatar}
            profileError={profileError}
          />
        </section>

        <nav className="mt-5 space-y-1 border-t border-white/5 pt-4" aria-label="Settings sections">
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
              <ChevronRight
                aria-hidden="true"
                className="ml-auto h-4 w-4 text-white/60 sm:hidden"
              />
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
          mobileSectionOpen || mobileBackAnimating ? 'block' : 'hidden'
        } flex-1 p-3 focus:outline-none sm:block sm:p-6 ${
          active === 'about' ? 'overflow-hidden' : 'overflow-y-auto'
        } ${mobileBackAnimating ? paneBackExitMotion : ''}`}
      >
        <div
          key={active}
          className={`${mobileBackAnimating ? '' : surfaceEnterMotion} ${
            active === 'about' ? 'flex h-full min-h-0 flex-col' : ''
          }`}
        >
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
            </div>
            <IconButton
              onClick={closeSettings}
              className="ml-auto sm:hidden"
              aria-label="Close settings"
            >
              <X className="h-5 w-5" />
            </IconButton>
          </div>

          {active === 'security' && <SecuritySettings />}

          {active === 'privacy' && (
            <PrivacySettings settings={privacySettings} onSettingsChange={setPrivacySettings} />
          )}

          {active === 'notifications' && <NotificationSettings deviceId={deviceId} />}

          {active === 'appearance' && (
            <AppearanceSettings
              accentId={accentId}
              fontSizeLevel={fontSizeLevel}
              onAccentIdChange={setAccentId}
              onFontSizeLevelChange={setFontSizeLevel}
            />
          )}

          {active === 'storage' && <DataStorageSettings />}

          {active === 'about' && <AboutSettings />}

          {active === 'team' && serverProfile?.role === 'admin' && (
            <TeamSettings currentUserId={serverProfile.userId} />
          )}

          {active === 'admin' && serverProfile?.role === 'admin' && <AdminPanel />}
        </div>
      </section>
    </Modal>
  );
}
