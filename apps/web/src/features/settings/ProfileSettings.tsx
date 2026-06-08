import { useEffect, useState, type CSSProperties, type ChangeEvent } from 'react';
import { Check, Copy, Image, RefreshCw } from 'lucide-react';
import { generatedAvatar, MAX_AVATAR_DATA_URI_LENGTH, safeAvatarSrc } from '../chat/seed';
import { Avatar, Button } from '../ui';

export interface AnonymousProfile {
  id: string;
  username: string;
  avatar: string;
}

interface ProfileSettingsProps {
  profile: AnonymousProfile;
  primaryButtonStyle: CSSProperties;
  onProfileChange: (profile: AnonymousProfile) => boolean;
}

const INPUT =
  'w-full rounded-xl border border-white/5 bg-[#1a1a26] px-4 py-2.5 text-sm text-white placeholder-white/30 transition-all focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/20';
const SUBTLE_BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm font-medium text-white/70 transition-colors hover:border-purple-500/40 hover:text-white';
const ALLOWED_AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const AVATAR_CANVAS_SIZE = 192;

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

export function ProfileSettings({
  profile,
  primaryButtonStyle,
  onProfileChange,
}: ProfileSettingsProps) {
  const [username, setUsername] = useState(profile.username);
  const [avatar, setAvatar] = useState(profile.avatar);
  const [copied, setCopied] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    setUsername(profile.username);
    setAvatar(profile.avatar);
    setProfileError(null);
  }, [profile]);

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

  return (
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
  );
}
