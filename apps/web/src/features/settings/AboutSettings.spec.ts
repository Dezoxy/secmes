import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { releaseNotes } from '../../lib/release-notes';
import {
  PwaUpdateContextProvider,
  defaultPwaUpdateContext,
  type PwaUpdateContextValue,
} from '../pwa/PwaUpdateContext';

vi.mock('../../lib/auth', () => ({ accessToken: vi.fn(async () => null) }));

import { AboutSettings, fetchBackendStatus } from './AboutSettings';

const serviceInfo = { service: 'argus-api', version: '0.0.0', status: 'ok' };

function renderAbout(value: Partial<PwaUpdateContextValue> = {}): string {
  return renderToStaticMarkup(
    createElement(PwaUpdateContextProvider, {
      value: { ...defaultPwaUpdateContext, ...value },
      children: createElement(AboutSettings),
    }),
  );
}

describe('AboutSettings', () => {
  it('shows backend status and release notes without a standalone version footer', () => {
    const html = renderAbout();

    expect(html).toContain('Backend status');
    expect(html).toContain('Offline');
    expect(html).toContain('Release notes');
    expect(html).toContain(releaseNotes[0]!.version);
    expect(html).toContain(releaseNotes[0]!.title);
    expect(html).toContain(releaseNotes.at(-1)!.version);
    expect(html).not.toContain('v0.0.0');
    expect(html).not.toContain('Argus secure messaging');
    expect(html).not.toContain('Safe diagnostic export');
    expect(html).not.toContain('Diagnostics menu reserved');
  });

  it('shows a manual PWA update check and platform install note', () => {
    const html = renderAbout({
      canCheckForUpdate: true,
      status: 'idle',
    });

    expect(html).toContain('App update');
    expect(html).toContain('Check');
    expect(html).toContain('Android, iOS, iPadOS, macOS, and desktop browsers can install Argus');
  });

  it('shows restart copy when an app shell update is ready', () => {
    const html = renderAbout({
      canCheckForUpdate: true,
      updateReady: true,
      status: 'available',
    });

    expect(html).toContain('A new app shell is ready');
    expect(html).toContain('Restart');
  });

  it('maps valid service info to online', async () => {
    const fetcher: typeof fetch = async () =>
      new Response(JSON.stringify(serviceInfo), { status: 200 });

    await expect(fetchBackendStatus(fetcher)).resolves.toBe('online');
  });

  it('maps HTTP, validation, and network failures to offline', async () => {
    const httpFailure: typeof fetch = async () => new Response('nope', { status: 500 });
    const invalidServiceInfo: typeof fetch = async () =>
      new Response(JSON.stringify({ ...serviceInfo, status: 'bad' }), { status: 200 });
    const networkFailure: typeof fetch = async () => {
      throw new Error('down');
    };

    await expect(fetchBackendStatus(httpFailure)).resolves.toBe('offline');
    await expect(fetchBackendStatus(invalidServiceInfo)).resolves.toBe('offline');
    await expect(fetchBackendStatus(networkFailure)).resolves.toBe('offline');
  });
});
