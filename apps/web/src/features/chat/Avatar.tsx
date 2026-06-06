import { Users } from 'lucide-react';

// Offline, generated avatars: initials on a deterministic gradient. No external image requests
// (privacy + works in the installed PWA offline), replacing the design's stock-photo avatars.

function hueFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

interface AvatarProps {
  name: string;
  /** Diameter in px. */
  size?: number;
  online?: boolean;
  group?: boolean;
}

export function Avatar({ name, size = 48, online = false, group = false }: AvatarProps) {
  const hue = hueFromString(name);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div
        className="flex h-full w-full select-none items-center justify-center rounded-full ring-2 ring-white/5"
        style={{
          background: `linear-gradient(135deg, oklch(0.55 0.16 ${hue}), oklch(0.42 0.15 ${(hue + 40) % 360}))`,
          fontSize: size * 0.36,
        }}
        aria-hidden
      >
        <span className="font-semibold tracking-tight text-white/90">{initials(name)}</span>
      </div>
      {online && (
        <span
          className="absolute bottom-0 right-0 rounded-full bg-green-500 ring-2 ring-[#12121a]"
          style={{ width: size * 0.28, height: size * 0.28 }}
        />
      )}
      {group && (
        <span
          className="absolute -bottom-1 -right-1 flex items-center justify-center rounded-full bg-purple-500 ring-2 ring-[#12121a]"
          style={{ width: size * 0.42, height: size * 0.42 }}
        >
          <Users className="text-white" style={{ width: size * 0.26, height: size * 0.26 }} />
        </span>
      )}
    </div>
  );
}
