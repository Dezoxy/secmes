import { Avatar } from '@argus/web';

// No `src` — safeAvatarSrc falls back to a deterministic, offline-generated initials avatar
// (DiceBear, as a data-URI SVG), argus's real default: no external image requests, no stock photos.
export function Sizes() {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
      <Avatar name="Alex Thompson" size="sm" />
      <Avatar name="Alex Thompson" size="md" />
      <Avatar name="Alex Thompson" size="lg" />
      <Avatar name="Alex Thompson" size="xl" />
    </div>
  );
}

export function Shapes() {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <Avatar name="Priya Sharma" size="lg" shape="rounded" />
      <Avatar name="Priya Sharma" size="lg" shape="circle" />
    </div>
  );
}

export function DifferentContacts() {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <Avatar name="Alex Thompson" size="md" />
      <Avatar name="Priya Sharma" size="md" />
      <Avatar name="Jordan Lee" size="md" />
      <Avatar name="Weekend Plans" size="md" shape="rounded" />
    </div>
  );
}
