import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { APP_VERSION_TAG } from '../../lib/app-version';

vi.mock('../../lib/auth', () => ({ accessToken: vi.fn(async () => null) }));

import { AboutSettings, fetchBackendStatus } from './AboutSettings';

const serviceInfo = { service: 'argus-api', version: '0.0.0', status: 'ok' };

describe('AboutSettings', () => {
  it('shows only backend status content and a quiet version footer', () => {
    const html = renderToStaticMarkup(createElement(AboutSettings));

    expect(html).toContain('Backend status');
    expect(html).toContain('Offline');
    expect(html).toContain(APP_VERSION_TAG);
    expect(html).not.toContain('Argus secure messaging');
    expect(html).not.toContain('Safe diagnostic export');
    expect(html).not.toContain('Diagnostics menu reserved');
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
