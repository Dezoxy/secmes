export interface PwaManifestIcon {
  src?: string;
  sizes?: string;
  type?: string;
  purpose?: string;
}

export interface PwaManifestCandidate {
  id?: string;
  name?: string;
  short_name?: string;
  description?: string;
  lang?: string;
  start_url?: string;
  scope?: string;
  theme_color?: string;
  background_color?: string;
  display?: string;
  orientation?: string;
  icons?: readonly PwaManifestIcon[];
}

const installableDisplayModes = new Set(['standalone', 'fullscreen', 'minimal-ui']);

export const argusPwaManifest = {
  id: '/',
  name: 'argus',
  short_name: 'argus',
  description: 'Privacy-first, end-to-end-encrypted messaging',
  lang: 'en',
  start_url: '/',
  scope: '/',
  theme_color: '#1a1a24',
  background_color: '#1a1a24',
  display: 'standalone',
  orientation: 'portrait',
  icons: [
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    {
      src: '/maskable-icon-192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'maskable',
    },
    {
      src: '/maskable-icon-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
} as const satisfies PwaManifestCandidate;

function hasText(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function hasInstallableIcon(icons: readonly PwaManifestIcon[] | undefined): boolean {
  return (
    icons?.some(
      (icon) =>
        hasText(icon.src) &&
        hasText(icon.sizes) &&
        hasText(icon.type) &&
        icon.src?.startsWith('/') === true,
    ) ?? false
  );
}

function hasSizedPngIcon(icons: readonly PwaManifestIcon[] | undefined, size: string): boolean {
  return (
    icons?.some(
      (icon) =>
        icon.src?.startsWith('/') === true && icon.sizes === size && icon.type === 'image/png',
    ) ?? false
  );
}

function hasMaskablePngIcon(icons: readonly PwaManifestIcon[] | undefined, size: string): boolean {
  return (
    icons?.some(
      (icon) =>
        icon.src?.startsWith('/') === true &&
        icon.sizes === size &&
        icon.type === 'image/png' &&
        icon.purpose?.split(/\s+/).includes('maskable') === true,
    ) ?? false
  );
}

export function getPwaInstallabilityIssues(manifest: PwaManifestCandidate): string[] {
  const issues: string[] = [];

  if (!hasText(manifest.name)) issues.push('Manifest needs a name.');
  if (!hasText(manifest.short_name)) issues.push('Manifest needs a short_name.');
  if (!hasText(manifest.lang)) issues.push('Manifest needs a lang.');
  if (!hasText(manifest.start_url)) issues.push('Manifest needs a start_url.');
  if (!hasText(manifest.scope)) issues.push('Manifest needs a scope.');
  if (!hasText(manifest.id)) issues.push('Manifest needs a stable id.');
  if (!hasText(manifest.theme_color)) issues.push('Manifest needs a theme_color.');
  if (!hasText(manifest.background_color)) issues.push('Manifest needs a background_color.');
  if (!hasInstallableIcon(manifest.icons)) issues.push('Manifest needs at least one local icon.');
  if (!hasSizedPngIcon(manifest.icons, '192x192')) {
    issues.push('Manifest needs a local 192x192 PNG icon.');
  }
  if (!hasSizedPngIcon(manifest.icons, '512x512')) {
    issues.push('Manifest needs a local 512x512 PNG icon.');
  }
  if (!hasMaskablePngIcon(manifest.icons, '512x512')) {
    issues.push('Manifest needs a local 512x512 maskable PNG icon.');
  }
  if (!manifest.display || !installableDisplayModes.has(manifest.display)) {
    issues.push('Manifest display must be installable.');
  }

  return issues;
}
