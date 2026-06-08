import { useEffect, useState, type CSSProperties, type ChangeEvent } from 'react';
import {
  Bell,
  Brush,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  HardDrive,
  Image,
  Info,
  Lock,
  Monitor,
  RefreshCw,
  Shield,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react';
import { generatedAvatar, MAX_AVATAR_DATA_URI_LENGTH, safeAvatarSrc } from '../chat/seed';
import { RecoveryPanel } from '../recovery/RecoveryPanel';
import {
  Avatar,
  Button,
  IconButton,
  Modal,
  SettingsRow,
  StateBlock,
  accentOptions,
  defaultAccentId,
  getAccentById,
  isAccentId,
  type AccentId,
  type AccentOption,
} from '../ui';

export interface AnonymousProfile {
  id: string;
  username: string;
  avatar: string;
}

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

const ACCENT_STORAGE_KEY = 'argus.accentColor.v1';
const FONT_SIZE_STORAGE_KEY = 'argus.fontSizeLevel.v1';

const fontSizeLevels = Array.from({ length: 10 }, (_, index) => index + 1);

const INPUT =
  'w-full rounded-xl border border-white/5 bg-[#1a1a26] px-4 py-2.5 text-sm text-white placeholder-white/30 transition-all focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/20';
const SUBTLE_BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm font-medium text-white/70 transition-colors hover:border-purple-500/40 hover:text-white';
const ALLOWED_AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const AVATAR_CANVAS_SIZE = 192;

function readStoredAccent(): AccentId {
  if (typeof window === 'undefined') return defaultAccentId;
  const stored = window.localStorage.getItem(ACCENT_STORAGE_KEY);
  return isAccentId(stored) ? stored : defaultAccentId;
}

function readStoredFontSize(): number {
  if (typeof window === 'undefined') return 5;
  const stored = Number.parseInt(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY) ?? '', 10);
  return fontSizeLevels.includes(stored) ? stored : 5;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('failed to load avatar'));
    image.src = url;
  });
}

async function compressAvatar(file: File): Promise<string> {
  const objectUrl = window.URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_CANVAS_SIZE;
    canvas.height = AVATAR_CANVAS_SIZE;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('failed to prepare avatar');

    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const sourceSize = Math.min(sourceWidth, sourceHeight);
    const sourceX = Math.max(0, (sourceWidth - sourceSize) / 2);
    const sourceY = Math.max(0, (sourceHeight - sourceSize) / 2);

    context.fillStyle = '#111827';
    context.fillRect(0, 0, AVATAR_CANVAS_SIZE, AVATAR_CANVAS_SIZE);
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceSize,
      sourceSize,
      0,
      0,
      AVATAR_CANVAS_SIZE,
      AVATAR_CANVAS_SIZE,
    );

    const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    if (dataUrl.length > MAX_AVATAR_DATA_URI_LENGTH) {
      throw new Error('avatar is too large');
    }
    return dataUrl;
  } finally {
    window.URL.revokeObjectURL(objectUrl);
  }
}

function FontSizePicker({
  value,
  accent,
  onChange,
}: {
  value: number;
  accent: AccentOption;
  onChange: (value: number) => void;
}) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.03] p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-white">Font size</p>
          <p className="mt-0.5 text-xs text-white/40">Level {value} of 10</p>
        </div>
        <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-white/60">
          {value}
        </span>
      </div>

      <div className="relative px-1 pb-1 pt-2">
        <div className="absolute left-4 right-4 top-1/2 h-px bg-white/10" />
        <div className="relative grid grid-cols-10 gap-1">
          {fontSizeLevels.map((level) => {
            const selected = level === value;
            const markerSize = 10 + level;
            return (
              <button
                key={level}
                type="button"
                onClick={() => onChange(level)}
                className="flex h-10 items-center justify-center rounded-lg transition-colors hover:bg-white/[0.04]"
                aria-label={`Font size ${level}`}
                aria-pressed={selected}
              >
                <span
                  className="rounded-full ring-1 ring-white/15 transition-all"
                  style={{
                    width: markerSize,
                    height: markerSize,
                    backgroundColor: selected ? accent.hex : 'rgba(255,255,255,0.22)',
                    boxShadow: selected ? `0 0 18px ${accent.soft}` : 'none',
                  }}
                />
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-1 flex justify-between text-[11px] font-medium uppercase tracking-[0.08em] text-white/35">
        <span>Minimum</span>
        <span>Maximum</span>
      </div>
    </div>
  );
}

export function SettingsPanel({ profile, deviceId, onProfileChange, onClose }: SettingsPanelProps) {
  const [active, setActive] = useState<SectionId>('profile');
  const [username, setUsername] = useState(profile.username);
  const [avatar, setAvatar] = useState(profile.avatar);
  const [copied, setCopied] = useState(false);
  const [mobileSectionOpen, setMobileSectionOpen] = useState(false);
  const [accentId, setAccentId] = useState<AccentId>(() => readStoredAccent());
  const [fontSizeLevel, setFontSizeLevel] = useState(() => readStoredFontSize());
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    setUsername(profile.username);
    setAvatar(profile.avatar);
    setProfileError(null);
  }, [profile]);

  useEffect(() => {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, accentId);
  }, [accentId]);

  useEffect(() => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(fontSizeLevel));
  }, [fontSizeLevel]);

  const saveProfile = () => {
    const clean = username.trim() || profile.id.slice(0, 12);
    const safeAvatar = safeAvatarSrc(avatar, clean);
    if (onProfileChange({ ...profile, username: clean, avatar: safeAvatar })) {
      setAvatar(safeAvatar);
      setProfileError(null);
      return;
    }
    setProfileError('Profile could not be saved on this device. Use a smaller avatar.');
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(profile.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  const uploadAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!ALLOWED_AVATAR_TYPES.has(file.type)) {
      setProfileError('Use PNG, JPG, WebP, or GIF.');
      event.target.value = '';
      return;
    }
    try {
      setAvatar(await compressAvatar(file));
      setProfileError(null);
    } catch {
      setProfileError('Avatar could not be processed. Use a smaller image.');
    } finally {
      event.target.value = '';
    }
  };

  const activeSection = sections.find((section) => section.id === active) ?? sections[0]!;
  const ActiveIcon = activeSection.icon;
  const accent = getAccentById(accentId);
  const primaryButtonStyle = {
    backgroundColor: accent.hex,
    boxShadow: `0 18px 34px ${accent.soft}`,
  };
  const accentVariables = {
    '--settings-accent': accent.hex,
    '--settings-accent-soft': accent.soft,
  } as CSSProperties;

  return (
    <Modal
      ariaLabel="Settings"
      onClose={onClose}
      className="items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      contentClassName="flex h-[90vh] w-full max-w-4xl overflow-hidden rounded-2xl border border-white/5 bg-[#12121a] shadow-2xl shadow-black/50 sm:h-[82vh]"
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
          <div className="space-y-5">
            <div className="flex items-center gap-4">
              <Avatar
                src={avatar}
                name={username || profile.id}
                size="xl"
                className="ring-2 ring-purple-500/40"
              />
              <div className="flex flex-wrap gap-2">
                <label className={SUBTLE_BUTTON}>
                  <Image className="h-4 w-4" />
                  Upload avatar
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    onChange={(event) => void uploadAvatar(event)}
                  />
                </label>
                <Button
                  variant="subtle"
                  onClick={() => setAvatar(generatedAvatar(username || profile.id))}
                >
                  <RefreshCw className="h-4 w-4" />
                  Generate
                </Button>
              </div>
            </div>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-white/70">Username</span>
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Choose a username"
                className={INPUT}
              />
            </label>

            <div>
              <span className="mb-2 block text-sm font-medium text-white/70">Argus ID</span>
              <div className="flex gap-2">
                <input value={profile.id} readOnly className={`${INPUT} font-mono text-xs`} />
                <Button variant="subtle" onClick={() => void copyId()}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </div>

            <Button onClick={saveProfile} style={primaryButtonStyle}>
              Save profile
            </Button>
            {profileError && <p className="text-sm text-rose-300">{profileError}</p>}
          </div>
        )}

        {active === 'security' && (
          <div className="space-y-3">
            <SettingsRow title="Passkey-only login" value="Managed by Zitadel policy" enabled />
            <RecoveryPanel embedded />
          </div>
        )}

        {active === 'privacy' && (
          <div className="space-y-3">
            <SettingsRow title="Read receipts" value="Uses the product default" badge="Default" />
            <SettingsRow
              title="Typing indicators"
              value="Uses the product default"
              badge="Default"
            />
            <SettingsRow title="Link previews" value="Uses the product default" badge="Default" />
          </div>
        )}

        {active === 'notifications' && (
          <div className="space-y-3">
            <SettingsRow
              title="Push notifications"
              value="Automatically follows device permission"
              badge="Auto"
            />
            <SettingsRow title="Mentions only" value="Uses the product default" badge="Default" />
            <SettingsRow title="Quiet hours" value="Uses the product default" badge="Default" />
            <StateBlock icon={Bell} title="Conversation mute controls">
              Menu item is in place. We can wire the backend setting in the next pass.
            </StateBlock>
          </div>
        )}

        {active === 'appearance' && (
          <div className="space-y-3">
            <FontSizePicker value={fontSizeLevel} accent={accent} onChange={setFontSizeLevel} />
            <div className="rounded-xl border border-white/5 bg-white/[0.03] p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-white">Accent colour</p>
                  <p className="mt-0.5 text-xs text-white/40">
                    Pick a dark-mode accent that matches the current Argus contrast.
                  </p>
                </div>
                <span
                  className="h-8 w-8 shrink-0 rounded-full ring-2 ring-white/15"
                  style={{ backgroundColor: accent.hex, boxShadow: `0 0 24px ${accent.soft}` }}
                />
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {accentOptions.map((option) => {
                  const selected = option.id === accentId;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => setAccentId(option.id)}
                      className={`flex min-h-11 items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
                        selected
                          ? 'border-white/20 bg-white/[0.06] text-white'
                          : 'border-white/5 bg-black/10 text-white/55 hover:border-white/15 hover:text-white'
                      }`}
                      aria-pressed={selected}
                    >
                      <span
                        className="h-5 w-5 shrink-0 rounded-full ring-1 ring-white/20"
                        style={{ backgroundColor: option.hex }}
                      />
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      {selected && <Check className="h-4 w-4 shrink-0 text-white/70" />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {active === 'storage' && (
          <div className="space-y-3">
            <SettingsRow
              title="Encrypted local message cache"
              value="Stored on this device"
              enabled
            />
            <SettingsRow title="Clear local cache" value="Needs confirmation flow" />
            <SettingsRow title="Media auto-download" value="Off until attachment backend lands" />
          </div>
        )}

        {active === 'devices' && (
          <div className="space-y-3">
            <div className="rounded-xl border border-white/5 bg-white/[0.03] p-4">
              <p className="text-sm font-medium text-white">Current device</p>
              <p className="mt-2 break-all font-mono text-xs text-white/45">
                {deviceId ?? 'Not provisioned yet'}
              </p>
            </div>
            <SettingsRow title="Trusted devices" value="Requires backend device registry UI" />
            <SettingsRow title="Revoke device" value="Requires backend revoke endpoint" />
          </div>
        )}

        {active === 'about' && (
          <div className="space-y-3">
            <SettingsRow title="App" value="Argus secure messaging" enabled />
            <SettingsRow title="Backend status" value="Diagnostics menu reserved" />
            <StateBlock icon={Monitor} title="Safe diagnostic export">
              Menu item is in place. We can wire the backend setting in the next pass.
            </StateBlock>
          </div>
        )}
      </main>
    </Modal>
  );
}
