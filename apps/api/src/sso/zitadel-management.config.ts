import { readFileSync } from 'node:fs';

export const ZITADEL_MANAGEMENT_CONFIG = Symbol('ZITADEL_MANAGEMENT_CONFIG');

export interface ZitadelManagementConfig {
  baseUrl: string;
  pat: string;
  configured: boolean;
}

function resolvePat(): string {
  const file = process.env.ZITADEL_MANAGEMENT_PAT_FILE;
  if (file) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      return readFileSync(file, 'utf8').trim();
    } catch {
      console.warn(
        `sso: could not read ZITADEL_MANAGEMENT_PAT_FILE at ${file} — SSO endpoints will return 503`,
      );
      return '';
    }
  }
  return process.env.ZITADEL_MANAGEMENT_PAT ?? '';
}

export function buildZitadelManagementConfig(): ZitadelManagementConfig {
  const baseUrl = (process.env.OIDC_ISSUER ?? '').replace(/\/$/, '');
  const pat = resolvePat();
  return { baseUrl, pat, configured: Boolean(baseUrl && pat) };
}
