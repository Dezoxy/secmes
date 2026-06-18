const FALLBACK_APP_VERSION = '0.0.0';

/**
 * Normalize a raw build version to a bare semver display string, falling back to 0.0.0. The build value is the
 * git tag (`VITE_APP_VERSION`, injected by CD from `github.ref_name`) — strip the leading `aws-` experiment
 * prefix and a leading `v` so `aws-v0.4.0` and `v0.4.0` both become `0.4.0`. Empty/unset → 0.0.0 (local/dev).
 */
export function normalizeAppVersion(version: string | undefined): string {
  const stripped = (version ?? '').trim().replace(/^aws-/, '').replace(/^v/, '');
  return stripped.length > 0 ? stripped : FALLBACK_APP_VERSION;
}

export const APP_VERSION = normalizeAppVersion(
  import.meta.env.VITE_APP_VERSION as string | undefined,
);
export const APP_VERSION_TAG = `v${APP_VERSION}`;
