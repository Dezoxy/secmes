import { describe, expect, it } from 'vitest';
import webPackage from '../../package.json';
import { APP_VERSION, APP_VERSION_TAG } from './app-version';

describe('app version metadata', () => {
  it('uses the web package version as the app version tag', () => {
    expect(APP_VERSION).toBe(webPackage.version);
    expect(APP_VERSION_TAG).toBe(`v${webPackage.version}`);
  });
});
