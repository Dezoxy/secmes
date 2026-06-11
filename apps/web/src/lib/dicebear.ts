import { createAvatar } from '@dicebear/core';
import * as lorelei from '@dicebear/lorelei';

/** Deterministic lorelei portrait seeded by a stable user ID — always a local data URI, no network. */
export function dicebearAvatar(userId: string): string {
  const svg = createAvatar(lorelei, { seed: userId }).toString();
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const RASTER_PHOTO_RE = /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-zA-Z0-9+/]+=*$/i;

/** True only for user-uploaded raster photos — used to decide whether to override with DiceBear. */
export function isCustomPhoto(src: string, maxLen: number): boolean {
  return src.length <= maxLen && RASTER_PHOTO_RE.test(src);
}
