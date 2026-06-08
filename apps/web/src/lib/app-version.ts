const FALLBACK_APP_VERSION = '0.0.0';

function normalizedVersion(version: string | undefined): string {
  const trimmed = version?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : FALLBACK_APP_VERSION;
}

export const APP_VERSION = normalizedVersion(
  import.meta.env.VITE_APP_VERSION as string | undefined,
);
export const APP_VERSION_TAG = `v${APP_VERSION}`;
