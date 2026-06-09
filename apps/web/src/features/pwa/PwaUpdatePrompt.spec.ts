import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  PwaUpdateContextProvider,
  defaultPwaUpdateContext,
  type PwaUpdateContextValue,
} from './PwaUpdateContext';
import { PwaUpdatePrompt } from './PwaUpdatePrompt';

describe('PwaUpdatePrompt', () => {
  it('stays hidden until an app shell update is ready', () => {
    const html = renderToStaticMarkup(
      createElement(PwaUpdateContextProvider, {
        value: { ...defaultPwaUpdateContext, status: 'idle', canCheckForUpdate: true },
        children: createElement(PwaUpdatePrompt),
      }),
    );

    expect(html).toBe('');
  });

  it('shows restart and later actions for a ready app shell update', () => {
    const value: PwaUpdateContextValue = {
      ...defaultPwaUpdateContext,
      canCheckForUpdate: true,
      updateReady: true,
      showUpdatePrompt: true,
      status: 'available',
      applyUpdate: vi.fn(async () => undefined),
      dismissUpdate: vi.fn(),
    };

    const html = renderToStaticMarkup(
      createElement(PwaUpdateContextProvider, {
        value,
        children: createElement(PwaUpdatePrompt),
      }),
    );

    expect(html).toContain('Update available');
    expect(html).toContain('Restart');
    expect(html).toContain('Later');
  });
});
