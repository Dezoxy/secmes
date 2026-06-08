import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { APP_VERSION_TAG } from '../../lib/app-version';
import { AboutSettings } from './AboutSettings';

describe('AboutSettings', () => {
  it('shows the app version tag', () => {
    const html = renderToStaticMarkup(createElement(AboutSettings));

    expect(html).toContain('Version');
    expect(html).toContain(APP_VERSION_TAG);
  });
});
