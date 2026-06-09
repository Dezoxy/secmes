import { describe, expect, it } from 'vitest';

import { argusPwaManifest, getPwaInstallabilityIssues } from './pwa-installability';

describe('PWA installability policy', () => {
  it('keeps the Argus manifest installable without external assets', () => {
    expect(getPwaInstallabilityIssues(argusPwaManifest)).toEqual([]);
    expect(argusPwaManifest.start_url).toBe('/');
    expect(argusPwaManifest.scope).toBe('/');
    expect(argusPwaManifest.id).toBe('/');
    expect(argusPwaManifest.lang).toBe('en');
    expect(argusPwaManifest.display).toBe('standalone');
    expect(argusPwaManifest.icons).toEqual([
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ]);
  });

  it('flags manifest regressions that would break installability', () => {
    expect(
      getPwaInstallabilityIssues({
        name: 'argus',
        short_name: 'argus',
        display: 'browser',
        icons: [{ src: 'https://example.com/icon.png', sizes: '512x512', type: 'image/png' }],
      }),
    ).toEqual([
      'Manifest needs a lang.',
      'Manifest needs a start_url.',
      'Manifest needs a scope.',
      'Manifest needs a stable id.',
      'Manifest needs a theme_color.',
      'Manifest needs a background_color.',
      'Manifest needs at least one local icon.',
      'Manifest needs a local 192x192 PNG icon.',
      'Manifest needs a local 512x512 PNG icon.',
      'Manifest display must be installable.',
    ]);
  });
});
